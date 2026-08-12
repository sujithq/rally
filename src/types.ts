export type Vote = 'yes' | 'maybe' | 'no'
export type AccountMode = 'disabled' | 'optional' | 'required'

export interface SiteConfig {
  name: string
  title: string
  description: string
  themeColor: string
}

export interface AccountConfig {
  mode: AccountMode
  registration: 'open' | 'closed'
}

export interface PollConfig {
  maxDates: number | null
  maxResponses: number
}

export interface PublicInstanceConfig {
  site: SiteConfig
  accounts: AccountConfig
  polls: PollConfig
}

export interface InstanceConfig extends PublicInstanceConfig {
  deployment: {
    workerName: string
    apiBaseUrl: string
    allowedOrigins: string[]
  }
}

export interface PollOptionInput {
  date: string
  time: string
}

export interface PollOption extends PollOptionInput {
  id: string
}

export interface Participant {
  id: string
  name: string
  votes: Record<string, Vote>
  updatedAt: string
}

export interface Poll {
  id: string
  title: string
  organizer: string
  description: string
  location: string
  createdAt: string
  status: 'open' | 'closed'
  options: PollOption[]
  participants: Participant[]
  participantCount?: number
  viewerParticipantId?: string
}

export interface PollDraft {
  title: string
  organizer: string
  description: string
  location: string
  options: PollOptionInput[]
}

export interface CreatedPoll extends Poll {
  managementToken: string
}

export interface PollUpdate {
  title?: string
  organizer?: string
  description?: string
  location?: string
  status?: Poll['status']
  options?: Array<PollOptionInput & { id?: string }>
}

export interface ManagedPollReference {
  id: string
  managementToken: string
}

export interface SavedResponse {
  poll: Poll
  participantId: string
}

export interface AccountUser {
  id: string
  email: string
  name: string
}

export interface AuthSession {
  user: AccountUser
  token: string
}