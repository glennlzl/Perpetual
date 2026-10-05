/**
 * A refused request's reply. `sourceBusy` marks a source-bound request refused only while the controller saves a source
 * change, such as a gate moving the managed source to a pushed commit: the same request succeeds once that change is
 * saved, so a page's poll keeps what it last read and reads again.
 */
export interface ErrorReply { error: string; sourceBusy?: true }
