import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * Task tracking tools (plan §4.8): the current `Task*` surface
 * (TaskCreate/TaskUpdate/TaskList/TaskGet) backed by an in-memory store,
 * plus a legacy `TodoWrite` mapping (tier "partial") that replaces the
 * store contents wholesale.
 *
 * Every tool result carries `details.tasks` (a store snapshot) so session
 * state can be reconstructed from the transcript.
 */

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TaskRecord {
  /** Sequential integer id, as a string ("1", "2", ...). */
  id: string;
  subject: string;
  description?: string;
  /** Present-continuous form shown while the task is in progress. */
  activeForm?: string;
  status: TaskStatus;
  owner?: string;
  /** Ids of tasks blocking this one. */
  blockedBy: string[];
}

export class TaskStore {
  private tasks = new Map<string, TaskRecord>();
  private nextId = 1;

  create(input: {
    subject: string;
    description?: string;
    activeForm?: string;
    status?: TaskStatus;
  }): TaskRecord {
    const task: TaskRecord = {
      id: String(this.nextId++),
      subject: input.subject,
      status: input.status ?? "pending",
      blockedBy: [],
    };
    if (input.description !== undefined) task.description = input.description;
    if (input.activeForm !== undefined) task.activeForm = input.activeForm;
    this.tasks.set(task.id, task);
    return task;
  }

  get(id: string): TaskRecord | undefined {
    return this.tasks.get(id);
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()];
  }

  update(
    id: string,
    patch: {
      status?: TaskStatus | "deleted";
      subject?: string;
      description?: string;
      owner?: string;
      addBlockedBy?: string[];
    },
  ): TaskRecord | undefined {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`No task with id ${id}`);
    }
    if (patch.status === "deleted") {
      this.tasks.delete(id);
      return undefined;
    }
    if (patch.status !== undefined) task.status = patch.status;
    if (patch.subject !== undefined) task.subject = patch.subject;
    if (patch.description !== undefined) task.description = patch.description;
    if (patch.owner !== undefined) task.owner = patch.owner;
    if (patch.addBlockedBy) {
      for (const blocker of patch.addBlockedBy) {
        if (!task.blockedBy.includes(blocker)) task.blockedBy.push(blocker);
      }
    }
    return task;
  }

  /** Legacy TodoWrite semantics: wholesale replacement of the store contents. */
  replaceAll(
    todos: Array<{ content: string; status: TaskStatus; activeForm?: string }>,
  ): TaskRecord[] {
    this.tasks.clear();
    return todos.map((todo) =>
      this.create({
        subject: todo.content,
        status: todo.status,
        ...(todo.activeForm !== undefined ? { activeForm: todo.activeForm } : {}),
      }),
    );
  }

  /** Deep-copied snapshot for tool-result details (session-state reconstruction). */
  snapshot(): TaskRecord[] {
    return this.list().map((t) => ({ ...t, blockedBy: [...t.blockedBy] }));
  }
}

function formatTaskLine(task: TaskRecord): string {
  let line = `#${task.id} [${task.status}] ${task.subject}`;
  if (task.owner) line += ` (owner: ${task.owner})`;
  if (task.blockedBy.length > 0) {
    line += ` (blocked by: ${task.blockedBy.map((b) => `#${b}`).join(", ")})`;
  }
  return line;
}

function formatTaskDetails(task: TaskRecord): string {
  const lines = [
    `Task #${task.id}`,
    `Subject: ${task.subject}`,
    `Status: ${task.status}`,
  ];
  if (task.description !== undefined) lines.push(`Description: ${task.description}`);
  if (task.activeForm !== undefined) lines.push(`Active form: ${task.activeForm}`);
  if (task.owner !== undefined) lines.push(`Owner: ${task.owner}`);
  lines.push(
    task.blockedBy.length > 0
      ? `Blocked by: ${task.blockedBy.map((b) => `#${b}`).join(", ")}`
      : "Blocked by: (none)",
  );
  return lines.join("\n");
}

export function createTaskTools(): { tools: ToolDefinition[]; store: TaskStore } {
  const store = new TaskStore();

  const result = (text: string) => ({
    content: [{ type: "text" as const, text }],
    details: { tasks: store.snapshot() },
  });

  const taskCreate = defineTool({
    name: "TaskCreate",
    label: "Task Create",
    description:
      "Create a new tracked task. Returns the assigned task id. Use TaskUpdate to change " +
      "its status as work progresses.",
    parameters: Type.Object({
      subject: Type.String({ description: "Short imperative summary of the task" }),
      description: Type.Optional(Type.String({ description: "Longer task description" })),
      activeForm: Type.Optional(
        Type.String({ description: 'Present-continuous form, e.g. "Running tests"' }),
      ),
    }),
    async execute(_toolCallId, params) {
      const task = store.create(params);
      return result(`Created task #${task.id}: ${task.subject}`);
    },
  });

  const taskUpdate = defineTool({
    name: "TaskUpdate",
    label: "Task Update",
    description:
      "Update a tracked task: change status (pending/in_progress/completed, or deleted to " +
      "remove it), subject, description, owner, or add blocking task ids.",
    parameters: Type.Object({
      taskId: Type.String({ description: "Id of the task to update" }),
      status: Type.Optional(
        StringEnum(["pending", "in_progress", "completed", "deleted"] as const, {
          description: "New status; 'deleted' removes the task",
        }),
      ),
      subject: Type.Optional(Type.String({ description: "New subject" })),
      description: Type.Optional(Type.String({ description: "New description" })),
      owner: Type.Optional(Type.String({ description: "Owner of the task" })),
      addBlockedBy: Type.Optional(
        Type.Array(Type.String(), { description: "Task ids that block this task" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const { taskId, ...patch } = params;
      const updated = store.update(taskId, patch);
      if (updated === undefined) {
        return result(`Deleted task #${taskId}`);
      }
      return result(`Updated task #${updated.id}: ${formatTaskLine(updated)}`);
    },
  });

  const taskList = defineTool({
    name: "TaskList",
    label: "Task List",
    description: "List all tracked tasks with id, status, subject, owner and blockers.",
    parameters: Type.Object({}),
    async execute() {
      const tasks = store.list();
      if (tasks.length === 0) return result("No tasks.");
      return result(tasks.map(formatTaskLine).join("\n"));
    },
  });

  const taskGet = defineTool({
    name: "TaskGet",
    label: "Task Get",
    description: "Get the full details of one tracked task by id.",
    parameters: Type.Object({
      taskId: Type.String({ description: "Id of the task to fetch" }),
    }),
    async execute(_toolCallId, params) {
      const task = store.get(params.taskId);
      if (!task) {
        throw new Error(`No task with id ${params.taskId}`);
      }
      return result(formatTaskDetails(task));
    },
  });

  // Legacy mapping (tier "partial"): TodoWrite replaces the whole store.
  const todoWrite = defineTool({
    name: "TodoWrite",
    label: "Todo Write",
    description:
      "Legacy todo-list tool: replaces the entire task list with the given todos. " +
      "Prefer the TaskCreate/TaskUpdate/TaskList/TaskGet tools.",
    parameters: Type.Object({
      todos: Type.Array(
        Type.Object({
          content: Type.String({ description: "The todo text" }),
          status: StringEnum(["pending", "in_progress", "completed"] as const, {
            description: "Current status of the todo",
          }),
          activeForm: Type.Optional(
            Type.String({ description: "Present-continuous form of the todo" }),
          ),
        }),
        { description: "The complete todo list (replaces all existing tasks)" },
      ),
    }),
    async execute(_toolCallId, params) {
      const created = store.replaceAll(params.todos);
      return result(
        `Replaced task list with ${created.length} task(s). ` +
          "Note: the Task* tools (TaskCreate/TaskUpdate/TaskList/TaskGet) are preferred over TodoWrite.",
      );
    },
  });

  return {
    tools: [taskCreate, taskUpdate, taskList, taskGet, todoWrite],
    store,
  };
}
