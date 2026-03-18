import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
  TELEGRAM_BOT_POOL,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import { initBotPool } from './channels/telegram.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Initialize Telegram bot pool for agent teams (send-only pool bots)
  if (TELEGRAM_BOT_POOL.length > 0) {
    await initBotPool(TELEGRAM_BOT_POOL);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    // Self-configuration handlers (main group only)
    installSkill: async (skillName: string) => {
      try {
        // Ensure upstream remote exists
        try {
          execSync('git remote get-url upstream', { stdio: 'pipe' });
        } catch {
          execSync(
            'git remote add upstream https://github.com/qwibitai/nanoclaw.git',
            { stdio: 'pipe' },
          );
        }
        // Fetch and merge the skill branch
        execSync(`git fetch upstream skill/${skillName}`, { stdio: 'pipe' });
        execSync(`git merge upstream/skill/${skillName} --no-edit`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        // Rebuild
        execSync('npm run build', { stdio: 'pipe' });
        logger.info({ skillName }, 'Skill installed via IPC');
        return {
          success: true,
          message: `Skill ${skillName} installed successfully`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ skillName, err }, 'Failed to install skill via IPC');
        return { success: false, message: `Failed to install skill: ${msg}` };
      }
    },
    rebuildService: async () => {
      try {
        execSync('npm run build', { stdio: 'pipe' });
        execSync('./container/build.sh', { stdio: 'pipe' });
        // Restart via launchctl
        execSync('launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist', {
          stdio: 'pipe',
        });
        execSync('launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist', {
          stdio: 'pipe',
        });
        return { success: true, message: 'Service rebuilt and restarted' };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, message: `Failed to rebuild: ${msg}` };
      }
    },
    readEnv: (key: string) => process.env[key],
    writeEnv: (key: string, value: string) => {
      const envPath = path.join(process.cwd(), '.env');
      let content = '';
      if (fs.existsSync(envPath)) {
        content = fs.readFileSync(envPath, 'utf-8');
      }
      const lines = content.split('\n');
      const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
      if (idx >= 0) {
        lines[idx] = `${key}=${value}`;
      } else {
        lines.push(`${key}=${value}`);
      }
      fs.writeFileSync(envPath, lines.join('\n'));
      // Also sync to container env
      const containerEnvPath = path.join(process.cwd(), 'data/env/env');
      if (fs.existsSync(path.dirname(containerEnvPath))) {
        fs.writeFileSync(containerEnvPath, lines.join('\n'));
      }
    },
    // Calendar operations (main group only)
    calendarList: async (days: number) => {
      try {
        const scriptPath = path.join(process.cwd(), 'scripts', 'calendar.sh');
        const output = execSync(`${scriptPath} list ${days}`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 15000,
        });
        return { success: true, events: output };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: msg };
      }
    },
    calendarCreate: async (
      summary: string,
      start: string,
      end: string,
      location?: string,
      notes?: string,
    ) => {
      try {
        const scriptPath = path.join(process.cwd(), 'scripts', 'calendar.sh');
        const args = ['create', `"${summary}"`, `"${start}"`, `"${end}"`];
        if (location) args.push(`"${location}"`);
        if (notes) args.push(`"${notes}"`);
        execSync(`${scriptPath} ${args.join(' ')}`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 15000,
        });
        return { success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: msg };
      }
    },
    calendarSearch: async (query: string) => {
      try {
        const scriptPath = path.join(process.cwd(), 'scripts', 'calendar.sh');
        const output = execSync(`${scriptPath} search "${query}"`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 15000,
        });
        return { success: true, results: output };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: msg };
      }
    },
    // Email operations via Apple Mail
    emailList: async (hours: number) => {
      try {
        const scriptPath = path.join(process.cwd(), 'scripts', 'get-mail.sh');
        const output = execSync(`${scriptPath} ${hours}`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 20000,
        });
        return { success: true, emails: output };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: msg };
      }
    },
    emailSearch: async (query: string) => {
      try {
        // Use AppleScript to search Mail.app
        const output = execSync(
          `osascript -l JavaScript -e '
            const Mail = Application("Mail");
            const results = [];
            const q = "${query.replace(/"/g, '\\"')}".toLowerCase();
            for (const acct of Mail.accounts()) {
              try {
                const inbox = acct.mailboxes.byName("INBOX");
                const msgs = inbox.messages();
                for (let i = 0; i < Math.min(msgs.length, 200); i++) {
                  try {
                    const m = msgs[i];
                    const subj = (m.subject() || "").toLowerCase();
                    const from = (m.sender() || "").toLowerCase();
                    if (subj.includes(q) || from.includes(q)) {
                      results.push({subject: m.subject(), from: m.sender(), date: m.dateReceived().toISOString(), read: m.readStatus()});
                      if (results.length >= 20) break;
                    }
                  } catch(e) {}
                }
              } catch(e) {}
              if (results.length >= 20) break;
            }
            JSON.stringify(results, null, 2);
          '`,
          {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 20000,
          },
        );
        return { success: true, results: output };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: msg };
      }
    },
    // Restart session — kill the running container so next message spawns a fresh one
    restartSession: (groupFolder: string) => {
      try {
        const output = execSync(`container ls --format json`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const containers: { status: string; configuration: { id: string } }[] =
          JSON.parse(output || '[]');
        for (const c of containers) {
          if (
            c.status === 'running' &&
            c.configuration.id.includes(groupFolder.replace(/_/g, '-'))
          ) {
            execSync(`container stop ${c.configuration.id}`, { stdio: 'pipe' });
            logger.info(
              { container: c.configuration.id },
              'Container stopped via restart_session',
            );
          }
        }
      } catch (err) {
        logger.error({ err, groupFolder }, 'Failed to restart session');
      }
    },
    // Remote coding session — launches a coding agent on host in a tmux session
    startCodingSession: async (
      projectDir: string,
      prompt?: string,
      command?: string,
    ) => {
      try {
        // Validate project directory exists
        if (!fs.existsSync(projectDir)) {
          return {
            success: false,
            error: `Directory not found: ${projectDir}`,
          };
        }
        const sessionId = `claude-${Date.now()}`;
        // Build command — default to claude in normal (safe) mode
        let cmd: string;
        if (command) {
          cmd = command;
        } else {
          cmd = 'claude';
        }
        if (prompt) {
          cmd += ` -p "${prompt.replace(/"/g, '\\"')}"`;
        }
        // Launch in tmux session with a login shell so PATH is correct.
        // Use a temp script to avoid shell quoting hell with nested quotes.
        // Use explicit socket so launchd and user terminal share the same tmux server.
        const tmuxSocket = '/tmp/nanoclaw-tmux.sock';
        const scriptPath = `/tmp/nanoclaw-session-${sessionId}.sh`;
        const script = `#!/bin/zsh\nsource ~/.zshrc 2>/dev/null\ncd ${JSON.stringify(projectDir)} && ${cmd}\n`;
        fs.writeFileSync(scriptPath, script, { mode: 0o755 });
        execSync(
          `/opt/homebrew/bin/tmux -S ${tmuxSocket} new-session -d -s ${sessionId} ${scriptPath}`,
          { stdio: 'pipe', timeout: 10000 },
        );
        // Make socket accessible to the user
        try {
          fs.chmodSync(tmuxSocket, 0o777);
        } catch {
          /* ignore */
        }
        logger.info(
          { sessionId, projectDir, prompt, command: cmd },
          'Coding session started',
        );
        return { success: true, sessionId };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: msg };
      }
    },
    // Coding session management
    listCodingSessions: async () => {
      try {
        const output = execSync(
          '/opt/homebrew/bin/tmux -S /tmp/nanoclaw-tmux.sock list-sessions 2>/dev/null || echo "No sessions"',
          {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        ).trim();
        return { success: true, sessions: output };
      } catch {
        return { success: true, sessions: 'No active tmux sessions' };
      }
    },
    checkCodingSession: async (sessionId: string) => {
      try {
        // Capture the visible pane content
        const output = execSync(
          `/opt/homebrew/bin/tmux -S /tmp/nanoclaw-tmux.sock capture-pane -t ${sessionId} -p -S -50`,
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 },
        ).trim();
        return { success: true, output: output || '(empty screen)' };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Session not found or error: ${msg}` };
      }
    },
    sendToCodingSession: async (sessionId: string, input: string) => {
      try {
        // Send keys to the tmux session
        execSync(
          `/opt/homebrew/bin/tmux -S /tmp/nanoclaw-tmux.sock send-keys -t ${sessionId} ${JSON.stringify(input)} Enter`,
          { stdio: 'pipe', timeout: 5000 },
        );
        return { success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: msg };
      }
    },
    stopCodingSession: async (sessionId: string) => {
      try {
        execSync(
          `/opt/homebrew/bin/tmux -S /tmp/nanoclaw-tmux.sock kill-session -t ${sessionId}`,
          {
            stdio: 'pipe',
            timeout: 5000,
          },
        );
        return { success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: msg };
      }
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
