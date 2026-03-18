/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

// Calendar operations (main group only)
server.tool(
  'calendar_list',
  'List upcoming calendar events. Main group only. Returns events for the next N days.',
  {
    days: z.number().default(30).describe('Number of days to look ahead (default 30)'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can access calendar.' }],
        isError: true,
      };
    }

    const requestId = `cal-${Date.now()}`;
    const data = {
      type: 'calendar_list',
      days: args.days,
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    // Wait for response
    const responsePath = path.join(IPC_DIR, 'responses', `${requestId}.json`);
    const maxWait = 10000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      await new Promise((r) => setTimeout(r, 500));
      if (fs.existsSync(responsePath)) {
        const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
        fs.unlinkSync(responsePath);
        if (response.success) {
          return { content: [{ type: 'text' as const, text: response.events || 'No events found.' }] };
        }
        return { content: [{ type: 'text' as const, text: `Error: ${response.error}` }], isError: true };
      }
    }

    return { content: [{ type: 'text' as const, text: 'Timeout waiting for calendar response.' }], isError: true };
  },
);

server.tool(
  'calendar_create',
  'Create a new calendar event. Main group only.',
  {
    summary: z.string().describe('Event title/summary'),
    start: z.string().describe('Start time in format "YYYY-MM-DD HH:MM" (e.g., "2026-03-15 14:00")'),
    end: z.string().describe('End time in format "YYYY-MM-DD HH:MM" (e.g., "2026-03-15 15:00")'),
    location: z.string().optional().describe('Optional location'),
    notes: z.string().optional().describe('Optional notes/description'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can access calendar.' }],
        isError: true,
      };
    }

    const requestId = `cal-${Date.now()}`;
    const data: Record<string, string | number | undefined> = {
      type: 'calendar_create',
      summary: args.summary,
      startDate: args.start,
      endDate: args.end,
      location: args.location,
      notes: args.notes,
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    // Wait for response
    const responsePath = path.join(IPC_DIR, 'responses', `${requestId}.json`);
    const maxWait = 15000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      await new Promise((r) => setTimeout(r, 500));
      if (fs.existsSync(responsePath)) {
        const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
        fs.unlinkSync(responsePath);
        if (response.success) {
          return { content: [{ type: 'text' as const, text: `Event created: ${args.summary}` }] };
        }
        return { content: [{ type: 'text' as const, text: `Error: ${response.error}` }], isError: true };
      }
    }

    return { content: [{ type: 'text' as const, text: 'Timeout waiting for calendar response.' }], isError: true };
  },
);

server.tool(
  'calendar_search',
  'Search calendar events by title/summary. Main group only.',
  {
    query: z.string().describe('Search query to match against event titles'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can access calendar.' }],
        isError: true,
      };
    }

    const requestId = `cal-${Date.now()}`;
    const data = {
      type: 'calendar_search',
      query: args.query,
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    // Wait for response
    const responsePath = path.join(IPC_DIR, 'responses', `${requestId}.json`);
    const maxWait = 10000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      await new Promise((r) => setTimeout(r, 500));
      if (fs.existsSync(responsePath)) {
        const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
        fs.unlinkSync(responsePath);
        if (response.success) {
          return { content: [{ type: 'text' as const, text: response.results || 'No matching events found.' }] };
        }
        return { content: [{ type: 'text' as const, text: `Error: ${response.error}` }], isError: true };
      }
    }

    return { content: [{ type: 'text' as const, text: 'Timeout waiting for calendar response.' }], isError: true };
  },
);

// Self-configuration tools (main group only)
server.tool(
  'install_skill',
  'Install a NanoClaw skill from upstream. Main group only. Fetches and merges the skill branch, then rebuilds.',
  {
    skill_name: z.string().describe('Name of the skill to install (e.g., "add-slack", "add-gmail", "add-voice-transcription")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can install skills.' }],
        isError: true,
      };
    }

    const requestId = `skill-${Date.now()}`;
    writeIpcFile(TASKS_DIR, {
      type: 'install_skill',
      skillName: args.skill_name,
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    const responsePath = path.join(IPC_DIR, 'responses', `${requestId}.json`);
    const maxWait = 60000; // Skills can take a while to install
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      await new Promise((r) => setTimeout(r, 1000));
      if (fs.existsSync(responsePath)) {
        const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
        fs.unlinkSync(responsePath);
        return { content: [{ type: 'text' as const, text: response.message || (response.success ? 'Skill installed.' : 'Install failed.') }], isError: !response.success };
      }
    }

    return { content: [{ type: 'text' as const, text: 'Timeout waiting for skill install.' }], isError: true };
  },
);

server.tool(
  'rebuild_service',
  'Rebuild NanoClaw (code + container) and restart the service. Main group only.',
  {},
  async () => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can rebuild.' }],
        isError: true,
      };
    }

    const requestId = `rebuild-${Date.now()}`;
    writeIpcFile(TASKS_DIR, {
      type: 'rebuild_service',
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    const responsePath = path.join(IPC_DIR, 'responses', `${requestId}.json`);
    const maxWait = 120000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      await new Promise((r) => setTimeout(r, 2000));
      if (fs.existsSync(responsePath)) {
        const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
        fs.unlinkSync(responsePath);
        return { content: [{ type: 'text' as const, text: response.message || (response.success ? 'Rebuilt.' : 'Rebuild failed.') }], isError: !response.success };
      }
    }

    return { content: [{ type: 'text' as const, text: 'Timeout waiting for rebuild.' }], isError: true };
  },
);

server.tool(
  'restart_session',
  'Restart your own container session. Use this after installing skills or when you need a fresh session with updated tools. Main group only. Your current session will end — send a message to start a new one.',
  {},
  async () => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can restart sessions.' }],
        isError: true,
      };
    }

    const requestId = `restart-${Date.now()}`;
    writeIpcFile(TASKS_DIR, {
      type: 'restart_session',
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    return { content: [{ type: 'text' as const, text: 'Session restart requested. This session will end shortly — send a new message to start a fresh session with updated tools.' }] };
  },
);

server.tool(
  'start_coding_session',
  `Launch a coding agent on the host machine (outside the container) in a tmux session. Main group only. The user can attach to the session remotely via SSH.

Available commands:
• "claude" (default) — Claude Code with normal permission checks
• "ccs glm" — cheaper GLM model, good for overnight/batch tasks to save tokens
• "ccs kimi" — Kimi model
• Any other CLI command that accepts -p for prompts

The session runs on the HOST machine (not in a container), so it has real access to the filesystem. Claude's normal permission mode applies — it will ask before destructive actions.`,
  {
    project_dir: z.string().describe('Absolute path to the project directory on the host (e.g., "/Users/jonathanomahony/personal/ravell-parent")'),
    prompt: z.string().optional().describe('Optional initial prompt for the coding agent'),
    command: z.string().optional().describe('Command to run (default: "claude"). Use "ccs glm" for cheaper overnight tasks.'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can start coding sessions.' }],
        isError: true,
      };
    }

    const requestId = `code-${Date.now()}`;
    writeIpcFile(TASKS_DIR, {
      type: 'start_coding_session',
      projectDir: args.project_dir,
      prompt: args.prompt,
      command: args.command,
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    const responsePath = path.join(IPC_DIR, 'responses', `${requestId}.json`);
    const maxWait = 15000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      await new Promise((r) => setTimeout(r, 500));
      if (fs.existsSync(responsePath)) {
        const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
        fs.unlinkSync(responsePath);
        if (response.success) {
          return { content: [{ type: 'text' as const, text: `Coding session started: ${response.sessionId}\nAttach with: tmux attach -t ${response.sessionId}` }] };
        }
        return { content: [{ type: 'text' as const, text: `Error: ${response.error}` }], isError: true };
      }
    }

    return { content: [{ type: 'text' as const, text: 'Timeout waiting for coding session start.' }], isError: true };
  },
);

// Coding session management (main group only)
server.tool(
  'list_coding_sessions',
  'List all active tmux coding sessions on the host. Main group only.',
  {},
  async () => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can manage coding sessions.' }], isError: true };
    }
    const requestId = `cs-${Date.now()}`;
    writeIpcFile(TASKS_DIR, { type: 'list_coding_sessions', requestId, groupFolder, timestamp: new Date().toISOString() });
    const responsePath = path.join(IPC_DIR, 'responses', `${requestId}.json`);
    const maxWait = 5000;
    const startTime = Date.now();
    while (Date.now() - startTime < maxWait) {
      await new Promise((r) => setTimeout(r, 500));
      if (fs.existsSync(responsePath)) {
        const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
        fs.unlinkSync(responsePath);
        return { content: [{ type: 'text' as const, text: response.sessions || 'No sessions.' }] };
      }
    }
    return { content: [{ type: 'text' as const, text: 'Timeout.' }], isError: true };
  },
);

server.tool(
  'check_coding_session',
  'Read the last ~50 lines of visible output from a tmux coding session. Use this to see what the coding agent is doing, if it\'s stuck, or what it produced. Main group only.',
  {
    session_id: z.string().describe('The tmux session ID (e.g., "claude-1773516176283")'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can manage coding sessions.' }], isError: true };
    }
    const requestId = `cs-${Date.now()}`;
    writeIpcFile(TASKS_DIR, { type: 'check_coding_session', sessionId: args.session_id, requestId, groupFolder, timestamp: new Date().toISOString() });
    const responsePath = path.join(IPC_DIR, 'responses', `${requestId}.json`);
    const maxWait = 5000;
    const startTime = Date.now();
    while (Date.now() - startTime < maxWait) {
      await new Promise((r) => setTimeout(r, 500));
      if (fs.existsSync(responsePath)) {
        const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
        fs.unlinkSync(responsePath);
        if (response.success) {
          return { content: [{ type: 'text' as const, text: response.output || '(empty)' }] };
        }
        return { content: [{ type: 'text' as const, text: `Error: ${response.error}` }], isError: true };
      }
    }
    return { content: [{ type: 'text' as const, text: 'Timeout.' }], isError: true };
  },
);

server.tool(
  'send_to_coding_session',
  'Send input/text to a running tmux coding session. The text is typed into the session followed by Enter. Use this to answer prompts, provide instructions, or interact with the coding agent. Main group only.',
  {
    session_id: z.string().describe('The tmux session ID'),
    input: z.string().describe('Text to send to the session (followed by Enter)'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can manage coding sessions.' }], isError: true };
    }
    const requestId = `cs-${Date.now()}`;
    writeIpcFile(TASKS_DIR, { type: 'send_to_coding_session', sessionId: args.session_id, input: args.input, requestId, groupFolder, timestamp: new Date().toISOString() });
    const responsePath = path.join(IPC_DIR, 'responses', `${requestId}.json`);
    const maxWait = 5000;
    const startTime = Date.now();
    while (Date.now() - startTime < maxWait) {
      await new Promise((r) => setTimeout(r, 500));
      if (fs.existsSync(responsePath)) {
        const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
        fs.unlinkSync(responsePath);
        if (response.success) {
          return { content: [{ type: 'text' as const, text: 'Input sent.' }] };
        }
        return { content: [{ type: 'text' as const, text: `Error: ${response.error}` }], isError: true };
      }
    }
    return { content: [{ type: 'text' as const, text: 'Timeout.' }], isError: true };
  },
);

server.tool(
  'stop_coding_session',
  'Kill a tmux coding session. Use this to stop a coding agent that\'s done or stuck. Main group only.',
  {
    session_id: z.string().describe('The tmux session ID to kill'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can manage coding sessions.' }], isError: true };
    }
    const requestId = `cs-${Date.now()}`;
    writeIpcFile(TASKS_DIR, { type: 'stop_coding_session', sessionId: args.session_id, requestId, groupFolder, timestamp: new Date().toISOString() });
    const responsePath = path.join(IPC_DIR, 'responses', `${requestId}.json`);
    const maxWait = 5000;
    const startTime = Date.now();
    while (Date.now() - startTime < maxWait) {
      await new Promise((r) => setTimeout(r, 500));
      if (fs.existsSync(responsePath)) {
        const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
        fs.unlinkSync(responsePath);
        if (response.success) {
          return { content: [{ type: 'text' as const, text: `Session ${args.session_id} killed.` }] };
        }
        return { content: [{ type: 'text' as const, text: `Error: ${response.error}` }], isError: true };
      }
    }
    return { content: [{ type: 'text' as const, text: 'Timeout.' }], isError: true };
  },
);

// Email tools (main group only)
server.tool(
  'email_list',
  'List recent emails from Apple Mail inbox. Main group only.',
  {
    hours: z.number().default(24).describe('Number of hours to look back (default 24)'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can access email.' }],
        isError: true,
      };
    }

    const requestId = `email-${Date.now()}`;
    writeIpcFile(TASKS_DIR, {
      type: 'email_list',
      hours: args.hours,
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    const responsePath = path.join(IPC_DIR, 'responses', `${requestId}.json`);
    const maxWait = 20000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      await new Promise((r) => setTimeout(r, 500));
      if (fs.existsSync(responsePath)) {
        const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
        fs.unlinkSync(responsePath);
        if (response.success) {
          return { content: [{ type: 'text' as const, text: response.emails || 'No emails found.' }] };
        }
        return { content: [{ type: 'text' as const, text: `Error: ${response.error}` }], isError: true };
      }
    }

    return { content: [{ type: 'text' as const, text: 'Timeout waiting for email response.' }], isError: true };
  },
);

server.tool(
  'email_search',
  'Search emails by subject or sender. Main group only.',
  {
    query: z.string().describe('Search query to match against email subjects and senders'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can access email.' }],
        isError: true,
      };
    }

    const requestId = `email-${Date.now()}`;
    writeIpcFile(TASKS_DIR, {
      type: 'email_search',
      query: args.query,
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    const responsePath = path.join(IPC_DIR, 'responses', `${requestId}.json`);
    const maxWait = 20000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      await new Promise((r) => setTimeout(r, 500));
      if (fs.existsSync(responsePath)) {
        const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
        fs.unlinkSync(responsePath);
        if (response.success) {
          return { content: [{ type: 'text' as const, text: response.results || 'No matching emails found.' }] };
        }
        return { content: [{ type: 'text' as const, text: `Error: ${response.error}` }], isError: true };
      }
    }

    return { content: [{ type: 'text' as const, text: 'Timeout waiting for email response.' }], isError: true };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
