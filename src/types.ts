export type Vote = 'yes' | 'maybe' | 'no'

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
}

export interface PollDraft {
  title: string
  organizer: string
  description: string
  location: string
  options: PollOptionInput[]
}

export interface SavedResponse {
  poll: Poll
  participantId: string
}