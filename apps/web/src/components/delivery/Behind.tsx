import { Button } from "../ui/button";

/**
 * Said when a settings form's changes were made against an older revision than the one saved
 * now: saving them would go over what another window saved, unseen, so the form holds them until
 * the person looks at what is saved.
 */
export function Behind(props: {
  readonly revision: number;
  readonly base: number;
  readonly onShowRead: () => void;
}) {
  return (
    <div className="flex flex-col gap-1 text-xs text-warning" data-delivery-behind>
      <p>
        Saved again elsewhere since your changes began (revision {props.revision} now, {props.base}{" "}
        then). Saving yours would go over that unseen, so it is held: look at what is saved, then
        make your changes again.
      </p>
      <Button size="xs" variant="outline" className="self-start" onClick={props.onShowRead}>
        Show what is saved
      </Button>
    </div>
  );
}
