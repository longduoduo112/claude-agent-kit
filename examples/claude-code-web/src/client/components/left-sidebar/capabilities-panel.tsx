import { Children, useMemo, useState } from 'react'
import { ChevronDown, RefreshCw, Terminal } from 'lucide-react'

import type { CapabilitySnapshot, LocalSkill } from '@/types/capabilities'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'

type CapabilitiesPanelProps = {
  capabilities?: CapabilitySnapshot | null
  isLoading?: boolean
  errorMessage?: string | null
  onRefresh?: () => void | Promise<void>
}

export function CapabilitiesPanel({
  capabilities,
  isLoading,
  errorMessage,
  onRefresh,
}: CapabilitiesPanelProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const tools = capabilities?.tools ?? []
  const slashCommands = capabilities?.slashCommands ?? []
  const skills = capabilities?.skills ?? []
  const mcpServers = capabilities?.mcpServers ?? []
  const localSkills = capabilities?.localSkills ?? []
  const hasData =
    tools.length +
    slashCommands.length +
    skills.length +
    mcpServers.length +
    localSkills.length > 0

  return (
    <section className="rounded-lg border border-border bg-card/50 text-xs text-muted-foreground shadow-sm">
      <header className="flex items-center justify-between gap-3 p-3">
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex flex-1 items-center gap-2 text-left"
        >
          <ChevronDown
            className={cn(
              'h-4 w-4 text-muted-foreground transition-transform duration-200',
              isExpanded ? 'rotate-0' : '-rotate-90',
            )}
          />
          <div>
            <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Terminal className="h-4 w-4 text-muted-foreground" />
              Claude Capabilities
            </p>
            {!isExpanded && (
              <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
                {capabilities
                  ? buildSummaryLine(capabilities) || 'Ready.'
                  : 'Inspect available tools.'}
              </p>
            )}
          </div>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRefresh?.()
          }}
          disabled={isLoading}
          className="inline-flex items-center gap-1 rounded-full border border-input px-2 py-1 text-[11px] font-medium text-muted-foreground transition hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
          aria-label="Refresh Claude capabilities"
        >
          <RefreshCw className={cn('h-3 w-3', isLoading && 'animate-spin')} />
        </button>
      </header>

      {isExpanded && (
        <div className="border-t border-border px-3 pb-3 pt-2">
          <p className="mb-3 text-[11px] text-muted-foreground">
            {capabilities
              ? buildSummaryLine(capabilities) ||
              'Ready to inspect available tools.'
              : 'Inspect Claude once to discover available tools.'}
          </p>

          {errorMessage ? (
            <p className="mb-2 rounded-md border border-destructive/20 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
              {errorMessage}
            </p>
          ) : null}

          {hasData ? (
            <div className="space-y-2">
              <CapabilitySection title={`Tools (${tools.length})`}>
                {tools.map((tool) => (
                  <CapabilityBadge key={tool} label={tool} />
                ))}
              </CapabilitySection>

              <CapabilitySection
                title={`MCP Servers (${mcpServers.length})`}
                defaultOpen
              >
                {mcpServers.map((server) => (
                  <div
                    key={server.name}
                    className="flex items-center justify-between rounded-md bg-muted/50 px-2 py-1"
                  >
                    <span className="font-medium text-foreground">
                      {server.name}
                    </span>
                    <StatusBadge status={server.status} />
                  </div>
                ))}
              </CapabilitySection>

              <CapabilitySection
                title={`Local Skills (${localSkills.length})`}
                defaultOpen
              >
                {localSkills.map((skill) => (
                  <SkillCard key={skill.slug} skill={skill} />
                ))}
              </CapabilitySection>

              <CapabilitySection
                title={`Slash Commands (${slashCommands.length})`}
              >
                {slashCommands.map((command) => (
                  <CapabilityBadge key={command} label={`/${command}`} />
                ))}
              </CapabilitySection>

              <CapabilitySection title={`Skills (${skills.length})`}>
                {skills.length > 0 ? (
                  skills.map((skill) => (
                    <CapabilityBadge
                      key={skill}
                      label={skill}
                      variant="ghost"
                    />
                  ))
                ) : (
                  <p className="text-muted-foreground">Nothing available.</p>
                )}
              </CapabilitySection>
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              Run any prompt or press refresh to capture Claude&apos;s available
              tools, MCP servers, and slash commands.
            </p>
          )}
        </div>
      )}
    </section>
  )
}

type CapabilitySectionProps = {
  title: string
  children: React.ReactNode
  defaultOpen?: boolean
}

function CapabilitySection({ title, children, defaultOpen }: CapabilitySectionProps) {
  const [open, setOpen] = useState(Boolean(defaultOpen))

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border border-slate-100 bg-slate-50/60 px-2 py-1">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between text-left text-[11px] font-semibold text-slate-700"
        >
          <span>{title}</span>
          <ChevronDown
            className={cn('h-3 w-3 transition-transform duration-150', open ? 'rotate-0' : '-rotate-90')}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 space-y-1 text-[11px]">
        {Children.count(children) === 0 ? (
          <p className="text-slate-400">Nothing available.</p>
        ) : (
          children
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

type CapabilityBadgeProps = {
  label: string
  variant?: 'solid' | 'ghost'
}

function CapabilityBadge({ label, variant = 'solid' }: CapabilityBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
        variant === 'solid'
          ? 'bg-slate-900/90 text-white'
          : 'bg-slate-100 text-slate-600',
      )}
    >
      {label}
    </span>
  )
}

type StatusBadgeProps = {
  status: string
}

function StatusBadge({ status }: StatusBadgeProps) {
  const { label, tone } = useMemo(() => classifyStatus(status), [status])

  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium', tone.bg, tone.text)}>
      <span className={cn('h-2 w-2 rounded-full', tone.dot)} />
      {label}
    </span>
  )
}

function classifyStatus(status: string) {
  const label = status || 'unknown'
  const normalized = label.toLowerCase()
  if (normalized.includes('ready') || normalized.includes('connected')) {
    return {
      label,
      tone: {
        bg: 'bg-emerald-100/80',
        text: 'text-emerald-800',
        dot: 'bg-emerald-500',
      },
    }
  }

  if (normalized.includes('error') || normalized.includes('fail')) {
    return {
      label,
      tone: {
        bg: 'bg-red-100/80',
        text: 'text-red-700',
        dot: 'bg-red-500',
      },
    }
  }

  return {
    label,
    tone: {
      bg: 'bg-slate-100',
      text: 'text-slate-600',
      dot: 'bg-slate-400',
    },
  }
}

function buildSummaryLine(capabilities: CapabilitySnapshot): string {
  const parts: string[] = []

  if (capabilities.model) {
    parts.push(`Model ${capabilities.model}`)
  }

  if (capabilities.cwd) {
    parts.push(capabilities.cwd)
  }

  if (capabilities.permissionMode) {
    parts.push(`Mode: ${capabilities.permissionMode}`)
  }

  return parts.join(' • ')
}

type SkillCardProps = {
  skill: LocalSkill
}

function SkillCard({ skill }: SkillCardProps) {
  return (
    <div className="rounded-md border border-slate-200 bg-white/70 px-2 py-1">
      <p className="text-[12px] font-semibold text-slate-800">{skill.name}</p>
      {skill.description && (
        <p className="text-[11px] text-slate-500">{skill.description}</p>
      )}
    </div>
  )
}
