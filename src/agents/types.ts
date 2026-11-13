/**
 * Единый интерфейс бэкендов-агентов (раздел 8.3 ai-dev-environment.md).
 * ClaudeBackend — через @anthropic-ai/claude-agent-sdk.
 * CodexBackend  — появится на шаге 4 дорожной карты.
 */

/** Provider IDs are host-owned metadata, never supplied by the webview. */
export type NativePromptAnchor =
  | { provider: "codex"; sessionId: string; turnId: string }
  | { provider: "claude"; sessionId: string; userMessageUuid: string; transcriptPath: string };

export interface PrepareEditOptions {
  cwd: string;
  sessionId: string;
  anchor?: NativePromptAnchor;
  legacyPrompt?: string;
  /** Host-only opt-in for a final unsent prompt with a verified saved-log boundary. */
  allowSavedContextFallback?: boolean;
  signal: AbortSignal;
  config: AgentRunConfig;
  extraEnv?: Record<string, string>;
  cliPath?: string;
}

export interface PreparedEdit {
  /** Undefined means a fresh native session, using the host's retained conversation if available. */
  resumeSessionId?: string;
  /** Original absent from complete native history; host must reconstruct its verified saved prefix. */
  contextFallback?: boolean;
  /** Retained OLD provider turn/message IDs -> anchors in the fork. */
  remappedAnchors?: Record<string, NativePromptAnchor>;
}

/** Нормализованные события, которые бэкенд отдаёт наружу независимо от модели. */
export type AgentEvent =
  | { kind: "nativePrompt"; messageId: string; anchor: NativePromptAnchor }
  | { kind: "session"; sessionId: string; forkedFromSessionId?: string }
  | { kind: "activity"; label: string }
  | { kind: "textDelta"; text: string }
  | { kind: "assistantText"; text: string }
  | { kind: "toolUse"; toolName: string; summary: string }
  | {
      kind: "result";
      ok: boolean;
      costUsd?: number;
      durationMs?: number;
      numTurns?: number;
    }
  | { kind: "contextUsage"; usedTokens: number; maxTokens: number }
  | {
      kind: "model";
      model: string;
      /** Заполнено, если модель фактически понижена фоллбэком с указанной. */
      fallbackFrom?: string;
    }
  | { kind: "notice"; text: string }
  | {
      /** Агент задаёт вопрос с вариантами (Codex request_user_input). */
      kind: "question";
      id: string;
      questions: { title: string; options: { label: string; description?: string }[] }[];
    }
  | {
      /** Доступные slash-команды CLI (Claude отдаёт их после init). */
      kind: "commands";
      commands: { name: string; description?: string; argumentHint?: string }[];
    }
  | {
      /** Актуальные модели CLI (Claude: supportedModels после init). */
      kind: "models";
      models: {
        value: string;
        displayName?: string;
        description?: string;
        supportedEffortLevels?: string[];
      }[];
    }
  | {
      kind: "error";
      message: string;
      /** Codex: тред занят другим процессом (thread-store conflict). */
      code?: "codexWriterConflict";
      threadId?: string;
    };

/** Настройки агента из VS Code settings (модель, effort и т.п.). */
export interface AgentRunConfig {
  model?: string;
  effort?: string;
  permissionMode?: string;
  maxTurns?: number;
  sandbox?: string;
  /** Codex: --dangerously-bypass-approvals-and-sandbox (без песочницы и подтверждений). */
  yolo?: boolean;
  /** Окно контекста для индикатора; 0 — бэкенд определяет по модели. */
  contextWindow: number;
}

/**
 * Канал корректировки на лету: бэкенд на время хода ставит handler,
 * хост вызывает его, чтобы докинуть сообщение в идущий ход.
 * now — немедленно (прерывает текущий шаг), next — на ближайшей границе шага.
 */
export interface SteerChannel {
  handler?: (text: string, mode: "now" | "next") => Promise<void>;
}

/** Host-only full snapshots. Values must never be copied into prompts or tool arguments. */
export interface LiveAccessChannel {
  readonly current: Readonly<Record<string, string>>;
  readonly revision: number;
  readonly publicContext: string | undefined;
  /** Every environment name owned by this run, including names since removed. */
  readonly ownedKeys: readonly string[];
  /** Commits before notifying subscribers; a delivery failure rejects without rolling back. */
  update(next: Record<string, string>, publicContext?: string): Promise<void>;
  subscribe(listener: (snapshot: Readonly<Record<string, string>>, revision: number) => void | Promise<void>): () => void;
}

/** Per-run encrypted snapshot shell bootstrap. Environment and command contain metadata only. */
export interface LiveAccessBridge {
  readonly environment: Record<string, string>;
  readonly refreshCommand: string;
  readonly contextPath: string;
  dispose(): Promise<void>;
}

export interface StartOptions {
  /** Stable host user-message ID (UUID for Claude streamed input). */
  messageId?: string;
  /** Рабочая папка проекта, в которой действует агент. */
  cwd: string;
  /** id прошлой сессии для возобновления диалога. */
  resumeSessionId?: string;
  /** Дополнительные переменные окружения (например, пароль сервера из SecretStorage). */
  extraEnv?: Record<string, string>;
  /** Host-owned live access snapshots, isolated by logical project and active run. */
  liveAccess?: LiveAccessChannel;
  /** Настройки модели/поведения агента. */
  config: AgentRunConfig;
  /** Абсолютные пути приложенных файлов (изображения Codex получает через -i). */
  attachments?: { path: string; isImage: boolean }[];
  /** Сигнал отмены (кнопка «Стоп»). */
  signal: AbortSignal;
  /** Claude: запросить список моделей у CLI даже при resume (кэш устарел). */
  refreshModels?: boolean;
  /** Claude: путь к исполняемому claude вместо встроенного в SDK. */
  cliPath?: string;
  /** Докидывание сообщений в идущий ход (если бэкенд умеет). */
  steer?: SteerChannel;
  /**
   * Колбэк подтверждения инструмента.
   * allow=true — разрешить; allow=false + answer — пользователь ответил на
   * вопрос агента (AskUserQuestion), текст доставляется через deny-message.
   */
  confirmTool: (
    toolName: string,
    input: unknown,
  ) => Promise<{ allow: boolean; answer?: string }>;
}

export interface AgentBackend {
  readonly id: string;
  start(prompt: string, opts: StartOptions): AsyncIterable<AgentEvent>;
  prepareEdit?(opts: PrepareEditOptions): Promise<PreparedEdit>;
}
