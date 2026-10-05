/** A canvas viewport: its pan in screen pixels and its zoom. */
export interface Viewport { x: number; y: number; zoom: number }
/** A stage card's horizontal extent in flow coordinates. */
export interface StageBox { id: string; x: number; width: number }
/** A box in flow coordinates. */
export interface FlowBox { x: number; y: number; width: number; height: number }

// The smallest canvas type is 12px; automatic framing never draws it below 11px.
export const READABLE_ZOOM = 0.92;

// Stages sit in one row: cards at least this wide, this far apart. At the entry
// zoom the default four stages fit a 1280px window with the sidebar collapsed.
// A coarse pointer's 52px transition controls get a wider gap to stay clear of
// both cards and the arrowhead.
export const STAGE_MIN_WIDTH = 256;
export const stageGap = (coarse = false) => coarse ? 88 : 64;

// The first stage lines up with the canvas toolbars. A pipeline that overflows
// by a little may trim both insets to EDGE_INSET rather than slice its last card.
export const FRAME_INSET = Object.freeze({ left: 20, top: 32, right: 20 });
const EDGE_INSET = 8;

// The first frame is already the automatic framing of a pipeline wider than its
// canvas: the first stage at readable size. A narrow screen never draws a
// whole-pipeline fit with unreadable type before framing settles.
export const INITIAL_PIPELINE_VIEWPORT: Readonly<Viewport> = Object.freeze({ x: FRAME_INSET.left, y: FRAME_INSET.top, zoom: READABLE_ZOOM });

const clampZoom = (zoom: number) => Math.min(1, Math.max(READABLE_ZOOM, zoom));
const extent = (boxes: readonly Pick<StageBox, 'x' | 'width'>[]) => Math.max(0, ...boxes.map(box => box.x + box.width));

// Stage boxes in flow coordinates, in pipeline order, from React Flow nodes.
export const stageBoxes = (nodes: readonly { id: string; position: { x: number; y?: number }; measured?: { width?: number; height?: number }; width?: number | null }[]): StageBox[] => nodes.map(node => ({ id: node.id, x: node.position.x, width: node.measured?.width ?? node.width ?? STAGE_MIN_WIDTH }));

// Automatic framing starts at the first stage at a readable zoom, up to 1. When
// the pipeline cannot fit, it keeps READABLE_ZOOM and shows the card at the right
// edge whole if trimming the insets is enough; otherwise panning and Fit view
// reach the rest. Explicit Fit view remains unrestricted.
export function entryViewport(boxes: readonly StageBox[] = [], { width = 0 }: { width?: number } = {}): Viewport {
  const right = extent(boxes);
  if (!right || !(width > 0)) return INITIAL_PIPELINE_VIEWPORT;
  const zoom = clampZoom((width - FRAME_INSET.left - FRAME_INSET.right) / right);
  const edge = (width - FRAME_INSET.left) / zoom;
  const cut = boxes.find(box => box.x < edge && box.x + box.width > edge);
  const whole = cut ? width - EDGE_INSET - (cut.x + cut.width) * zoom : FRAME_INSET.left;
  return { x: whole >= EDGE_INSET ? Math.min(FRAME_INSET.left, whole) : FRAME_INSET.left, y: FRAME_INSET.top, zoom };
}

// Fit view keeps its zoom and horizontal centring but starts the row at the
// entry height instead of floating it mid-canvas. A fit that needs the full
// height keeps its own inset.
export function alignTop(viewport: Viewport): Viewport;
export function alignTop(viewport: Viewport | null | undefined): Viewport | null | undefined;
export function alignTop(viewport: Viewport | null | undefined) { return viewport && viewport.y > FRAME_INSET.top ? { ...viewport, y: FRAME_INSET.top } : viewport; }

// A right-hand sheet narrows the canvas. The selected stage is uncovered beside
// it by the smallest horizontal pan and the zoom never changes; a stage already
// in view keeps the same viewport object.
type UncoverOptions = { width?: number; inset?: number };
export function uncoverViewport(viewport: Viewport, box: Pick<StageBox, 'x' | 'width'> | null | undefined, options?: UncoverOptions): Viewport;
export function uncoverViewport(viewport: Viewport | null | undefined, box: Pick<StageBox, 'x' | 'width'> | null | undefined, options?: UncoverOptions): Viewport | null | undefined;
export function uncoverViewport(viewport: Viewport | null | undefined, box: Pick<StageBox, 'x' | 'width'> | null | undefined, { width = 0, inset = FRAME_INSET.right }: UncoverOptions = {}) {
  if (!viewport || !box || !(width > 0)) return viewport;
  const left = viewport.x + box.x * viewport.zoom, right = left + box.width * viewport.zoom;
  let shift = right > width - inset ? width - inset - right : 0;
  if (left + shift < inset) shift = inset - left;
  return shift ? { ...viewport, x: viewport.x + shift } : viewport;
}

// Keyboard focus reveals its control by the smallest pan and never zooms. When
// the control is out of view across the canvas, its stage comes into view with
// it if both fit side by side (a transition control sits in the gap past its
// card); a tall stage only scrolls far enough to show the control. Boxes are in
// flow coordinates ({ x, y, width, height }).
const REVEAL_INSET = 16;
type RevealOptions = { width?: number; height?: number };
export function revealViewport(viewport: Viewport, control: FlowBox | null | undefined, stage: FlowBox | null | undefined, options?: RevealOptions): Viewport;
export function revealViewport(viewport: Viewport | null | undefined, control: FlowBox | null | undefined, stage: FlowBox | null | undefined, options?: RevealOptions): Viewport | null | undefined;
export function revealViewport(viewport: Viewport | null | undefined, control: FlowBox | null | undefined, stage: FlowBox | null | undefined, { width = 0, height = 0 }: RevealOptions = {}) {
  if (!viewport || !control || !(width > 0) || !(height > 0)) return viewport;
  const { x, y, zoom } = viewport;
  type Span = [start: number, end: number];
  const shift = ([start, end]: Span, low: number, high: number) => end - start > high - low || start < low ? low - start : end > high ? high - end : 0;
  const shown = ([start, end]: Span, low: number, high: number) => start >= low && end <= high;
  const left = FRAME_INSET.left, right = width - FRAME_INSET.right, top = REVEAL_INSET, bottom = height - REVEAL_INSET;
  const across: Span = [x + control.x * zoom, x + (control.x + control.width) * zoom];
  const down: Span = [y + control.y * zoom, y + (control.y + control.height) * zoom];
  const whole: Span | null | undefined = stage && [x + Math.min(stage.x, control.x) * zoom, x + Math.max(stage.x + stage.width, control.x + control.width) * zoom];
  const dx = shown(across, left, right) ? 0 : shift(whole && whole[1] - whole[0] <= right - left ? whole : across, left, right);
  const dy = shown(down, top, bottom) ? 0 : shift(down, top, bottom);
  return dx || dy ? { ...viewport, x: x + dx, y: y + dy } : viewport;
}

// The viewport a sheet borrows. Opening records the viewer's frame and closing
// returns it, unless the viewer panned or zoomed meanwhile (theirs stays) or a
// resize or layout change reframed the narrowed canvas (frame the full width).
// An animated move stands at its target until it lands: a sheet opened while a
// restore, an uncover or a focus reveal is still in flight records where the
// canvas is going, never the frame passing by. A drag, zoom or reframe cancels the flight.
export function createSheetViewport() {
  let session: { viewport: Viewport | null; moved: boolean } | null = null, flight: { target: Viewport } | null = null;
  const view = (live: Viewport) => flight ? flight.target : live;
  return {
    get active() { return Boolean(session); },
    view,
    animate<Landing>(target: Viewport, landing: Landing): Landing {
      const current = flight = { target };
      const land = () => { if (flight === current) flight = null; };
      Promise.resolve(landing).then(land, land);
      return landing;
    },
    open(live: Viewport) { if (!session) session = { viewport: view(live), moved: false }; },
    moved() { flight = null; if (session) session.moved = true; },
    reframed() { flight = null; if (session) session = { viewport: null, moved: false }; },
    close(): { restore: Viewport } | { frame: true } | null {
      if (!session) return null;
      const { viewport, moved } = session;
      session = null;
      return moved ? null : viewport ? { restore: viewport } : { frame: true };
    },
  };
}
