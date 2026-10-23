export type CompetitionVisibility = 'public'|'unlisted'|'private';
export type JoinPolicy = 'open'|'invite'|'approval';
export type CompetitionState = 'draft'|'scheduled'|'running'|'frozen'|'finished'|'archived';
export type ScoringMode = 'static'|'dynamic';
export type Role = 'owner'|'admin'|'author'|'reviewer'|'participant'|'observer';
export type MembershipStatus = 'invited'|'pending'|'active'|'banned';
export type Difficulty = 'easy'|'medium'|'hard';
export type TaskState = 'draft'|'review'|'published'|'hidden'|'archived';
export type TaskGrantPermission = 'view'|'edit'|'manage';
export type AttachmentVisibility = 'participants'|'staff';
export type AnnouncementAudience = 'all'|'staff'|'team';
export type TicketStatus = 'open'|'answered'|'closed';
export type TicketVisibility = 'private'|'public';
export type RequestStatus = 'pending'|'approved'|'rejected';
export interface User {id:number; username:string; created_at:string; is_instance_admin:boolean}
export interface Me extends User {competitions_owned:number; competitions_joined:number}
export type UserProfile = Me;
export interface Items<T> {items:T[]}
export interface Paginated<T> extends Items<T> {total:number; limit:number; offset:number}
export interface Viewer {role:Role|null; status:MembershipStatus|null; team_id:number|null; permissions:string[]}
export interface CompetitionCreate {title:string; description:string; visibility:CompetitionVisibility; join_policy:JoinPolicy; starts_at:string; freeze_at?:string|null; ends_at:string; team_mode:boolean; team_size_max:number; scoring:ScoringMode}
export interface CompetitionStats {participants:number; teams:number; tasks_published:number; solves:number; submissions:number}
export interface Competition extends CompetitionCreate {id:number; slug:string; owner_id:number; state:CompetitionState; created_at:string; updated_at:string; viewer:Viewer; stats:CompetitionStats}
export interface CompetitionSummary {id:number; slug:string; title:string; state:CompetitionState; visibility:CompetitionVisibility; join_policy:JoinPolicy; starts_at:string; ends_at:string; team_mode:boolean; participants:number; owner:Pick<User,'id'|'username'>; viewer?:Pick<Viewer,'role'|'status'>}
export interface Membership {competition_id:number; user_id:number; role:Role; status:MembershipStatus; invited_by:number|null; team_id:number|null; created_at:string; updated_at:string}
export interface Member {user_id:number; username:string; role:Role; status?:MembershipStatus; invited_by?:number|null; team?:{id:number; name:string}; joined_at:string; score?:number; viewer?:Viewer}
export interface Invite {code:string; competition_id:number; role:Exclude<Role,'owner'>; created_by:number; max_uses:number|null; uses:number; expires_at:string|null; revoked:boolean}
export interface JoinRequest {id:number; competition_id:number; user_id:number; message:string; status:RequestStatus; decided_by:number|null; created_at:string; decided_at:string|null}
export interface Team {id:number; competition_id:number; name:string; captain_id:number; join_code?:string; created_at:string; members?:{user_id:number; username:string; joined_at:string}[]; viewer?:Viewer}
export interface TaskCreate {title:string; description:string; category:string; difficulty:Difficulty; base_points?:number; answer_flag:string; reward_token:string; release_at?:string|null; max_solves?:number|null}
export interface TaskSummary {id:number; slug:string; title:string; category:string; difficulty:Difficulty; points:number; state?:TaskState; release_at?:string|null; solve_count:number; has_solved:boolean; author?:Pick<User,'id'|'username'>; viewer_permissions:string[]}
export interface PublicTask extends TaskSummary {description:string; attachments:Attachment[]; hints:HintView[]; max_solves:number|null; closed:boolean}
export interface ManagedTask extends PublicTask {answer_flag:string; reward_token:string; revision:number; base_points:number; grants_count:number; submissions_count:number; can_edit_secrets:boolean}
export interface TaskRevision {title:string; description:string; category:string; difficulty:Difficulty; base_points:number; answer_flag:string; reward_token:string; release_at:string|null; revision:number; created_by:number; created_at:string}
export interface TaskGrant {task_id:number; user_id:number; permission:TaskGrantPermission; granted_by:number; created_at:string}
export interface Attachment {id:number; task_id:number; filename:string; content_type:string; size:number; sha256:string; visibility:AttachmentVisibility; uploaded_by:number; created_at:string}
export interface Hint {id:number; task_id:number; order:number; body:string; cost:number}
export interface HintView {id:number; order:number; cost:number; unlocked:boolean; body?:string}
export interface Submission {id:number; task_id:number; user_id:number; team_id?:number|null; value?:string; correct:boolean; created_at:string}
export type SubmitResult = {correct:true; already_solved:boolean; reward_token:string; points:number; solved_at:string; message:string}|{correct:false; message:string};
export interface SolveRecord {competition:{slug:string; title:string}; task:{slug:string; title:string; difficulty:Difficulty}; reward_token:string; points_awarded:number; solved_at:string; team?:{id:number; name:string}}
export interface ScoreboardEntry {rank:number; user_id?:number; team_id?:number; name:string; score:number; solved:number; last_solve_at:string|null}
export interface Scoreboard {items:ScoreboardEntry[]; total:number; frozen:boolean; frozen_at?:string|null}
export interface Announcement {id:number; competition_id:number; author_id:number; audience:AnnouncementAudience; team_id?:number|null; title:string; body:string; pinned:boolean; created_at:string}
export interface Ticket {id:number; competition_id:number; task_id?:number|null; opened_by:number; team_id?:number|null; subject:string; status:TicketStatus; visibility:TicketVisibility; created_at:string; updated_at:string; messages?:TicketMessage[]; viewer?:Viewer}
export interface TicketMessage {id:number; ticket_id:number; author_id:number; body:string; internal:boolean; created_at:string}
export interface AuditEvent {id:number; competition_id:number; actor_id:number; action:string; target_type:string; target_id:number; data:Record<string,unknown>; created_at:string}
export interface ApiToken {id:number; user_id:number; name:string; prefix:string; scopes:string[]; competition_id:number|null; created_at:string; expires_at:string|null; last_used_at:string|null}
export interface CreatedApiToken extends ApiToken {token:string}
export interface Pin {id:number; competition_id:number; created_at:string}
export interface PlatformStats {users:number; competitions:number; running_competitions:number; tasks:number; solves:number}
export interface PublicUser extends User {competitions:CompetitionSummary[]}
export type CompetitionAction = 'publish'|'start'|'freeze'|'unfreeze'|'finish'|'archive';
export type TaskAction = 'submit'|'approve'|'reject'|'publish'|'hide'|'archive';
export const difficultyLabels:Record<Difficulty,string> = {easy:'Лёгкое',medium:'Среднее',hard:'Сложное'};
export const difficultyShortLabels = difficultyLabels;
export const difficultyScores:Record<Difficulty,number> = {easy:100,medium:250,hard:500};
