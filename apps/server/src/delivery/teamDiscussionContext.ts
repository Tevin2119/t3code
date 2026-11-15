/**
 * What the orchestrator is told once the participants' rounds are in. It alone hands out
 * work, so it is told who each participant is and what each may be given.
 */
export const teamDiscussionContext = (input: {
  readonly group: string;
  readonly members: ReadonlyArray<{
    readonly seat: string;
    readonly role: string;
    readonly providerInstanceId: string;
    readonly model: string;
    readonly access: "read-only" | "approval-required" | "full-access";
  }>;
  readonly skipped?:
    | ReadonlyArray<{
        readonly seat: string;
        readonly role: string;
        readonly reason: string;
        readonly contributed?: boolean | undefined;
      }>
    | undefined;
  readonly discussionDidNotRun?: boolean | undefined;
  readonly critiqueDidNotRun?: boolean | undefined;
  readonly contributions: string;
  /** Left out when the turn had no critique round. */
  readonly critiques?: string | undefined;
}) =>
  `<team_discussion>\nYou are the orchestrator for ${input.group}. ${input.discussionDidNotRun ? "The team discussion did not run because fewer than two seats could join. Answer alone and tell the user so." : input.critiqueDidNotRun ? "The contribution round completed but the critique round could not run because fewer than two seats could join; see the reasons below." : `The native participants have completed independent contributions${input.critiques === undefined ? "" : " and a critique round"}.`}${input.discussionDidNotRun ? "" : " Synthesize their evidence and disagreements into a response to the latest user message. Attribute useful insights to their seat/model, acknowledge failed or missing contributions, and distinguish consensus from unresolved disagreement."} Do not launch these rounds again.${input.skipped?.length ? `\n\nSkipped seats:\n${input.skipped.map((seat) => `- ${seat.seat} (${seat.role})${seat.contributed ? " contributed but could not join the critique round" : ""}: ${seat.reason}`).join("\n")}\nName each skipped seat and its reason in your answer. Do not delegate to skipped seats. If a missing seat's role (such as review or QA) is required for the work, stop and ask the person how to proceed; do not silently replace or bypass that role.` : ""}\n\nYou decide who does what. Any participating seats were told to change nothing. When the user asks for work to be done, do it yourself in this thread under the project's own rules, or hand each piece to one participant with \`delegate_task\`: pass that participant's \`target\` (providerInstanceId and model) and \`runtimeMode\` from the list below, and a \`task\` that stands on its own, because the child sees none of this conversation. Give one piece of work to one participant. When more than one child would change files at the same time, give each \`isolation: 'worktree'\`. Hand work that changes anything only to a participant marked "may change things"; a read-only participant gets a question or a review with \`interactionMode: 'plan'\`. Check each result before you tell the user it is done.\n\nParticipants:\n${input.members
    .map(
      (member) =>
        `- ${member.seat} (${member.role}): providerInstanceId ${member.providerInstanceId}, model ${member.model}, ${member.access === "read-only" ? "read-only: questions and reviews only" : `may change things (runtimeMode ${member.access})`}`,
    )
    .join(
      "\n",
    )}\n\nIndependent contributions:\n${input.contributions}${input.critiques === undefined ? "" : `\n\nCritiques:\n${input.critiques}`}\n</team_discussion>`;
