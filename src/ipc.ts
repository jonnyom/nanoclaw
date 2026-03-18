import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  IPC_POLL_INTERVAL,
  TIMEZONE,
  TELEGRAM_BOT_POOL,
} from './config.js';
import {
  sendPoolMessage,
  hasBotPool,
} from './channels/telegram.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

/** Calendar event structure for daily briefings */
export interface CalendarEvent {
  id: string;
  title: string;
  start: string; // ISO timestamp
  end?: string; // ISO timestamp
  location?: string;
  notes?: string;
  calendar?: string;
}

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  // Optional: self-configuration actions (main group only)
  installSkill?: (skillName: string) => Promise<{ success: boolean; message: string }>;
  rebuildService?: () => Promise<{ success: boolean; message: string }>;
  readEnv?: (key: string) => string | undefined;
  writeEnv?: (key: string, value: string) => void;
  // Calendar data provider
  getCalendarEvents?: (startDate: Date, endDate: Date) => Promise<CalendarEvent[]>;
  // Calendar operations (main group only)
  calendarList?: (days: number) => Promise<{ success: boolean; events?: string; error?: string }>;
  calendarCreate?: (summary: string, start: string, end: string, location?: string, notes?: string) => Promise<{ success: boolean; error?: string }>;
  calendarSearch?: (query: string) => Promise<{ success: boolean; results?: string; error?: string }>;
  // Email operations (main group only)
  emailList?: (hours: number) => Promise<{ success: boolean; emails?: string; error?: string }>;
  emailSearch?: (query: string) => Promise<{ success: boolean; results?: string; error?: string }>;
  // Remote coding session (main group only)
  startCodingSession?: (projectDir: string, prompt?: string, command?: string) => Promise<{ success: boolean; sessionId?: string; error?: string }>;
  // Restart the current container session (main group only)
  restartSession?: (groupFolder: string) => void;
  // Coding session management (main group only)
  listCodingSessions?: () => Promise<{ success: boolean; sessions?: string; error?: string }>;
  checkCodingSession?: (sessionId: string) => Promise<{ success: boolean; output?: string; error?: string }>;
  sendToCodingSession?: (sessionId: string, input: string) => Promise<{ success: boolean; error?: string }>;
  stopCodingSession?: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  // Route Telegram pool messages via bot pool for agent teams
                  // Only use pool bots for sub-agents, not the main assistant
                  if (
                    data.sender &&
                    data.sender.toLowerCase() !== ASSISTANT_NAME.toLowerCase() &&
                    data.chatJid.startsWith('tg:') &&
                    hasBotPool()
                  ) {
                    await sendPoolMessage(
                      data.chatJid,
                      data.text,
                      data.sender,
                      sourceGroup,
                    );
                  } else {
                    await deps.sendMessage(data.chatJid, data.text);
                  }
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup, sender: data.sender },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For self-configuration actions
    skillName?: string;
    requestId?: string;
    key?: string;
    value?: string;
    // For calendar operations
    days?: number;
    summary?: string;
    startDate?: string;
    endDate?: string;
    location?: string;
    notes?: string;
    query?: string;
    // For email operations
    hours?: number;
    // For remote coding session
    projectDir?: string;
    command?: string; // e.g. "ccs glm", "claude", defaults to "claude"
    sessionId?: string; // for check/send/stop coding session
    input?: string; // for send_to_coding_session
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    // Self-configuration actions (main group only)
    case 'install_skill': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized install_skill attempt blocked');
        break;
      }
      if (!deps.installSkill) {
        logger.warn('install_skill handler not configured');
        break;
      }
      if (data.skillName && typeof data.skillName === 'string') {
        const result = await deps.installSkill(data.skillName);
        logger.info(
          { skillName: data.skillName, success: result.success },
          'Skill install via IPC',
        );
        // Write response for container to read
        writeIpcResponse(sourceGroup, data.requestId, result);
      }
      break;
    }

    case 'rebuild_service': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized rebuild_service attempt blocked');
        break;
      }
      if (!deps.rebuildService) {
        logger.warn('rebuildService handler not configured');
        break;
      }
      const result = await deps.rebuildService();
      logger.info({ success: result.success }, 'Service rebuild via IPC');
      writeIpcResponse(sourceGroup, data.requestId, result);
      break;
    }

    case 'read_env': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized read_env attempt blocked');
        break;
      }
      if (!deps.readEnv) {
        logger.warn('readEnv handler not configured');
        break;
      }
      if (data.key && typeof data.key === 'string') {
        const value = deps.readEnv(data.key);
        writeIpcResponse(sourceGroup, data.requestId, {
          success: true,
          value: value ?? null,
        });
      }
      break;
    }

    case 'write_env': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized write_env attempt blocked');
        break;
      }
      if (!deps.writeEnv) {
        logger.warn('writeEnv handler not configured');
        break;
      }
      if (data.key && typeof data.key === 'string' && data.value !== undefined) {
        deps.writeEnv(data.key, String(data.value));
        logger.info({ key: data.key }, 'Env var written via IPC');
        writeIpcResponse(sourceGroup, data.requestId, { success: true });
      }
      break;
    }

    case 'calendar_list': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized calendar_list attempt blocked');
        break;
      }
      if (!deps.calendarList) {
        logger.warn('calendarList handler not configured');
        break;
      }
      const days = data.days ?? 30;
      const result = await deps.calendarList(days);
      logger.info({ days, success: result.success }, 'Calendar list via IPC');
      writeIpcResponse(sourceGroup, data.requestId, result);
      break;
    }

    case 'calendar_create': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized calendar_create attempt blocked');
        break;
      }
      if (!deps.calendarCreate) {
        logger.warn('calendarCreate handler not configured');
        break;
      }
      if (data.summary && data.startDate && data.endDate) {
        const result = await deps.calendarCreate(
          data.summary,
          data.startDate,
          data.endDate,
          data.location,
          data.notes,
        );
        logger.info({ summary: data.summary, success: result.success }, 'Calendar create via IPC');
        writeIpcResponse(sourceGroup, data.requestId, result);
      }
      break;
    }

    case 'calendar_search': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized calendar_search attempt blocked');
        break;
      }
      if (!deps.calendarSearch) {
        logger.warn('calendarSearch handler not configured');
        break;
      }
      if (data.query) {
        const result = await deps.calendarSearch(data.query);
        logger.info({ query: data.query, success: result.success }, 'Calendar search via IPC');
        writeIpcResponse(sourceGroup, data.requestId, result);
      }
      break;
    }

    case 'email_list': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized email_list attempt blocked');
        break;
      }
      if (!deps.emailList) {
        logger.warn('emailList handler not configured');
        break;
      }
      const hours = data.hours ?? 24;
      const emailResult = await deps.emailList(hours);
      logger.info({ hours, success: emailResult.success }, 'Email list via IPC');
      writeIpcResponse(sourceGroup, data.requestId, emailResult);
      break;
    }

    case 'email_search': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized email_search attempt blocked');
        break;
      }
      if (!deps.emailSearch) {
        logger.warn('emailSearch handler not configured');
        break;
      }
      if (data.query) {
        const emailSearchResult = await deps.emailSearch(data.query);
        logger.info({ query: data.query, success: emailSearchResult.success }, 'Email search via IPC');
        writeIpcResponse(sourceGroup, data.requestId, emailSearchResult);
      }
      break;
    }

    case 'restart_session': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized restart_session attempt blocked');
        break;
      }
      if (deps.restartSession) {
        logger.info({ sourceGroup }, 'Session restart requested via IPC');
        // Small delay so the IPC response can be written before the container dies
        setTimeout(() => deps.restartSession!(sourceGroup), 1000);
        writeIpcResponse(sourceGroup, data.requestId, { success: true, message: 'Restarting session...' });
      }
      break;
    }

    case 'start_coding_session': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized start_coding_session attempt blocked');
        break;
      }
      if (!deps.startCodingSession) {
        logger.warn('startCodingSession handler not configured');
        break;
      }
      if (data.projectDir) {
        const codingResult = await deps.startCodingSession(data.projectDir, data.prompt, data.command);
        logger.info(
          { projectDir: data.projectDir, success: codingResult.success },
          'Coding session started via IPC',
        );
        writeIpcResponse(sourceGroup, data.requestId, codingResult);
      }
      break;
    }

    case 'list_coding_sessions': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized list_coding_sessions attempt blocked');
        break;
      }
      if (deps.listCodingSessions) {
        const r = await deps.listCodingSessions();
        writeIpcResponse(sourceGroup, data.requestId, r);
      }
      break;
    }

    case 'check_coding_session': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized check_coding_session attempt blocked');
        break;
      }
      if (deps.checkCodingSession && data.sessionId) {
        const r = await deps.checkCodingSession(data.sessionId);
        writeIpcResponse(sourceGroup, data.requestId, r);
      }
      break;
    }

    case 'send_to_coding_session': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized send_to_coding_session attempt blocked');
        break;
      }
      if (deps.sendToCodingSession && data.sessionId && data.input) {
        const r = await deps.sendToCodingSession(data.sessionId, data.input);
        writeIpcResponse(sourceGroup, data.requestId, r);
      }
      break;
    }

    case 'stop_coding_session': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized stop_coding_session attempt blocked');
        break;
      }
      if (deps.stopCodingSession && data.sessionId) {
        const r = await deps.stopCodingSession(data.sessionId);
        writeIpcResponse(sourceGroup, data.requestId, r);
      }
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

/** Write a response file for the container to read. */
function writeIpcResponse(
  sourceGroup: string,
  requestId: string | undefined,
  result: Record<string, unknown>,
): void {
  if (!requestId) return;
  const responseDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'responses');
  fs.mkdirSync(responseDir, { recursive: true });
  const responsePath = path.join(responseDir, `${requestId}.json`);
  fs.writeFileSync(responsePath, JSON.stringify({ ...result, timestamp: new Date().toISOString() }));
}
