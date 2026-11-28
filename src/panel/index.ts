/** panel: the companion panel's extension side. Pure pieces so far (build steps 7+). */
export { ExchangeBuilder, lastTextPart, type CallState, type Exchange, type ReplyPart } from "./exchanges";
export { phaseOf, pendingCalls, pendingQuestion, hasPendingCall, hasPendingQuestion, STALE_EXCHANGE_MS, ASK_USER_QUESTION_TOOL, type EndReason, type Phase } from "./phase";
export { collectFileChanges, type FileChange } from "./files";
export { activityText, THINKING, WRITING_REPLY, type DisplayPath } from "./activity";
export { detectWaiting, PERMISSION_QUIET_MS, TOOLS_THAT_NEVER_ASK, TEXT_QUESTION_PREFIX, type Waiting, type WaitingConfidence } from "./waiting";
export { DecisionLinker, type LinkedDecision } from "./linker";
export { sectionState, type DecisionSectionState } from "./extraction";
