import { Check, ChevronsUpDown, Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

import { ProjectWithActivity } from './types'

type ProjectPickerProps = {
  projects: ProjectWithActivity[]
  selectedProjectId: string | null
  isLoading: boolean
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (projectId: string) => void
  onCreateProject?: (path: string) => void
  onDeleteProject?: (projectId: string, projectName: string) => void
}

export function ProjectPicker({
  projects,
  selectedProjectId,
  isLoading,
  isOpen,
  onOpenChange,
  onSelect,
  onCreateProject,
  onDeleteProject,
}: ProjectPickerProps) {
  return (
    <Popover open={isOpen} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={isOpen}
          className="w-full justify-between"
          disabled={isLoading || projects.length === 0}
        >
          {selectedProjectId
            ? projects.find((project) => project.id === selectedProjectId)?.name ??
            'Select project'
            : 'Select project'}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[240px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search projects..." />
          <CommandEmpty>No projects found.</CommandEmpty>
          <CommandList>
            <CommandGroup>
              {projects.map((project) => (
                <CommandItem
                  key={project.id}
                  value={`${project.name} -${project.id} `}
                  className="flex items-center justify-between"
                >
                  <div
                    className="flex items-center flex-1 cursor-pointer"
                    onClick={() => onSelect(project.id)}
                  >
                    <Check
                      className={cn(
                        'mr-2 h-4 w-4',
                        project.id === selectedProjectId ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    <span className="truncate">{project.name}</span>
                  </div>
                  {onDeleteProject && (
                    <button
                      className="ml-2 p-1 opacity-60 hover:opacity-100 hover:text-red-600 transition-opacity"
                      onClick={(e) => {
                        e.stopPropagation()
                        if (window.confirm(`⚠️ Delete workspace "${project.name}"?\n\nThis will permanently delete:\n• All files in the workspace directory\n• Session history (.claude/)\n• Skills and configurations\n\nThis action cannot be undone.`)) {
                          onDeleteProject(project.id, project.name)
                        }
                      }}
                      title="Delete project"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
            {onCreateProject && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    onSelect={() => {
                      const name = window.prompt('Enter workspace name:\n\nThis will create an independent workspace with its own session history, skills, and permissions.\n\nAllowed characters: letters, numbers, spaces, hyphens, underscores')
                      if (!name) return

                      const trimmedName = name.trim()
                      if (!trimmedName) return

                      // Validate project name
                      const validNamePattern = /^[\w][\w\s-]*$/
                      if (!validNamePattern.test(trimmedName)) {
                        alert('Invalid project name. Use only letters, numbers, spaces, hyphens, and underscores.')
                        return
                      }

                      if (trimmedName.length > 100) {
                        alert('Project name too long (max 100 characters)')
                        return
                      }

                      onCreateProject(trimmedName)
                      onOpenChange(false)
                    }}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    New Project
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
