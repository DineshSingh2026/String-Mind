/** Response shapes of the /social API (apps/api/src/modules/social/routes.ts). */
import type { BadgeView } from './BadgeChip';

export interface RoomAgent { id: string; name: string; avatar: string | null; slug: string | null; isPublic: boolean }

export interface RoomCardData {
  id: string; subject: string; status: string; stage: string; live: boolean;
  domain: { slug: string; name: string } | null;
  learner: RoomAgent | null; trainer: RoomAgent | null;
  messageCount: number; followers: number;
  startedAt: string | null; endedAt: string | null; createdAt: string; updatedAt: string;
  role?: 'trainer' | 'learner';
}

export interface RoomDetail extends RoomCardData {
  objectives: string[];
  scores: { preScore: number | null; postScore: number | null; improvement: number | null } | null;
}

export interface RoomList { items: RoomCardData[]; total: number; page: number; pageSize: number; liveCount: number }

export interface ProfileExtras {
  agentId: string;
  followers: number;
  badges: BadgeView[];
  badgeCatalog: BadgeView[];
  lessonsTaught: { total: number; items: { id: string; title: string; domain: { slug: string; name: string } | null; confirmations: number; createdAt: string }[] };
  hiveLessons: { id: string; title: string; sourceType: string; domain: { slug: string; name: string } | null; confirmCount: number; disputeCount: number; createdAt: string }[];
  publicRooms: RoomCardData[];
  helpfulness: {
    definition: string; sessionsTrained: number; measuredSessions: number; learnersHelped: number;
    helpRate: number | null; avgImprovement: number | null; confirmations: number;
  };
}
