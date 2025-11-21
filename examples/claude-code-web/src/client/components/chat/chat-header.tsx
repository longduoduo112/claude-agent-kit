type ChatHeaderProps = {
  sessionId: string | null
  isConnected: boolean
  connectionMessage: string | null
  onUploadSkillClick?: () => void
  isUploadingSkill?: boolean
  skillUploadMessage?: string | null
}

export function ChatHeader({
  sessionId,
  isConnected,
  connectionMessage,
  onUploadSkillClick,
  isUploadingSkill,
  skillUploadMessage,
}: ChatHeaderProps) {
  return (
    <header className="border-b border-border bg-background transition-colors">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold text-foreground font-sans">
            Claude Agent Chat
          </h1>
          <p className="text-sm text-muted-foreground font-serif">
            {sessionId ? `Session • ${sessionId}` : 'New session'}
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span
            className={`inline-flex items-center gap-2 rounded-full px-3 py-1 transition-colors ${
              isConnected
                ? 'bg-chart-3/10 text-chart-3'
                : 'bg-muted text-muted-foreground'
            }`}
          >
            <span className="inline-block h-2 w-2 rounded-full bg-current" />
            {isConnected ? 'Online' : 'Offline'}
          </span>
          <button
            type="button"
            className="rounded-full border border-input px-3 py-1 text-sm font-medium text-muted-foreground transition hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer"
            onClick={onUploadSkillClick}
            disabled={!onUploadSkillClick || isUploadingSkill}
          >
            {isUploadingSkill ? 'Uploading skill…' : 'Upload skill'}
          </button>
          {connectionMessage ? (
            <span className="text-xs text-muted-foreground">{connectionMessage}</span>
          ) : null}
        </div>
      </div>
      {skillUploadMessage ? (
        <div className="mx-auto flex w-full max-w-6xl justify-end px-6 pb-3 text-xs text-muted-foreground">
          {skillUploadMessage}
        </div>
      ) : null}
    </header>
  )
}
