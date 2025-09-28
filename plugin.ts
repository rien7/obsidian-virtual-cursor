import {
  PluginValue,
  ViewPlugin,
  ViewUpdate,
  EditorView,
} from "@codemirror/view";
import type { Rect } from "@codemirror/view";

const VIRTUAL_CURSOR_CLASS = "virtual-cursor";
const VIRTUAL_CURSOR_PHASE_CLASS = "cursor-phase";
const VIRTUAL_CURSOR_ENABLED_CLASS = "virtual-cursor-enabled";
const PHASE_DELAY = 200;

interface UpdateOptions {
  forcePosition?: boolean;
  restartPhase?: boolean;
}

interface MeasurementOptions {
  forcePosition: boolean;
  restartPhase: boolean;
}

interface CursorMeasurement {
  visible: boolean;
  rect?: Rect;
  hostRect?: DOMRect;
  head: number;
  options: MeasurementOptions;
}

function isCollapsedSelection(view: EditorView): boolean {
  return view.state.selection.main.empty;
}

class VirtualCursorView implements PluginValue {
  private cursor: HTMLDivElement;
  private phaseTimer: number | null = null;
  private lastHead: number | null = null;
  private resizeObserver?: ResizeObserver;
  private readonly cleanup: Array<() => void> = [];
  private scheduled = false;
  private pendingOptions: MeasurementOptions | undefined;

  private readonly measure: {
    read: (view: EditorView) => CursorMeasurement;
    write: (measure: CursorMeasurement, view: EditorView) => void;
  } = {
    read: (view: EditorView) => this.readMeasurement(view),
    write: (measure: CursorMeasurement, _view: EditorView) =>
      this.applyMeasurement(measure),
  };

  constructor(private readonly view: EditorView) {
    this.cursor = view.dom.ownerDocument.createElement("div");
    this.cursor.className = VIRTUAL_CURSOR_CLASS;
    this.cursor.style.display = "none";
    this.cursor.style.position = "absolute";
    this.cursor.style.left = "0";
    this.cursor.style.top = "0";

    const host = view.scrollDOM as HTMLElement;
    host.appendChild(this.cursor);
    view.dom.classList.add(VIRTUAL_CURSOR_ENABLED_CLASS);

    const onSelectionChange = () => {
      if (this.view.hasFocus) {
        window.requestAnimationFrame(() =>
          this.scheduleMeasurement({ restartPhase: true })
        );
      }
    };
    const root = view.dom.ownerDocument;
    root.addEventListener("selectionchange", onSelectionChange);
    this.cleanup.push(() =>
      root.removeEventListener("selectionchange", onSelectionChange)
    );

    const onScroll = () => this.scheduleMeasurement({ forcePosition: true });
    host.addEventListener("scroll", onScroll, { passive: true });
    this.cleanup.push(() => host.removeEventListener("scroll", onScroll));

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() =>
        this.scheduleMeasurement({ forcePosition: true })
      );
      this.resizeObserver.observe(host);
    }

    const onWindowResize = () =>
      this.scheduleMeasurement({ forcePosition: true });
    root.defaultView?.addEventListener("resize", onWindowResize);
    this.cleanup.push(() =>
      root.defaultView?.removeEventListener("resize", onWindowResize)
    );

    const onBlur = () => this.hideCursor();
    view.dom.addEventListener("blur", onBlur);
    this.cleanup.push(() => view.dom.removeEventListener("blur", onBlur));

    const onFocus = () =>
      this.scheduleMeasurement({
        forcePosition: true,
        restartPhase: true,
      });
    view.dom.addEventListener("focus", onFocus);
    this.cleanup.push(() => view.dom.removeEventListener("focus", onFocus));

    this.scheduleMeasurement({ forcePosition: true, restartPhase: true });
  }

  update(update: ViewUpdate) {
    if (
      update.docChanged ||
      update.selectionSet ||
      update.viewportChanged ||
      update.geometryChanged ||
      update.focusChanged
    ) {
      this.scheduleMeasurement({
        forcePosition:
          update.viewportChanged ||
          update.geometryChanged ||
          update.focusChanged ||
          update.docChanged ||
          update.selectionSet,
        restartPhase: update.docChanged || update.selectionSet,
      });
    }
  }

  destroy() {
    this.cleanup.forEach((fn) => fn());
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    if (this.phaseTimer !== null) {
      window.clearTimeout(this.phaseTimer);
      this.phaseTimer = null;
    }
    this.pendingOptions = undefined;
    this.scheduled = false;
    this.cursor.remove();
    this.view.dom.classList.remove(VIRTUAL_CURSOR_ENABLED_CLASS);
  }

  private scheduleMeasurement(options: UpdateOptions = {}) {
    if (!this.view.hasFocus || !isCollapsedSelection(this.view)) {
      this.hideCursor();
      this.lastHead = null;
      return;
    }

    const current: MeasurementOptions = this.pendingOptions ?? {
      forcePosition: false,
      restartPhase: false,
    };

    if (options.forcePosition) {
      current.forcePosition = true;
    }
    if (options.restartPhase) {
      current.restartPhase = true;
    }
    this.pendingOptions = current;

    if (!this.scheduled) {
      this.scheduled = true;
      this.view.requestMeasure(this.measure);
    }
  }

  private readMeasurement(view: EditorView): CursorMeasurement {
    const options = this.pendingOptions ?? {
      forcePosition: false,
      restartPhase: false,
    };

    this.pendingOptions = undefined;
    this.scheduled = false;

    if (!view.hasFocus || !isCollapsedSelection(view)) {
      return {
        visible: false,
        head: view.state.selection.main.head,
        options,
      };
    }

    const head = view.state.selection.main.head;
    let rect: Rect | null = null;
    try {
      rect = view.coordsAtPos(head, -1);
    } catch (_error) {
      rect = null;
    }

    if (!rect) {
      return {
        visible: false,
        head,
        options,
      };
    }

    const hostRect = (view.scrollDOM as HTMLElement).getBoundingClientRect();

    return {
      visible: true,
      rect,
      hostRect,
      head,
      options,
    };
  }

  private applyMeasurement(data: CursorMeasurement) {
    const { visible, rect, hostRect, head, options } = data;

    if (!visible || !rect || !hostRect) {
      this.hideCursor();
      this.lastHead = null;
      return;
    }

    const headChanged = this.lastHead !== head;

    if (!options.forcePosition && !headChanged) {
      return;
    }

    this.lastHead = head;

    const top = rect.top - hostRect.top;
    const left = rect.left - hostRect.left;
    const height = rect.bottom - rect.top;

    this.cursor.style.display = "block";
    this.cursor.style.height = `${height}px`;
    this.cursor.style.top = `${top}px`;
    this.cursor.style.left = `${left}px`;

    if (options.restartPhase || headChanged) {
      this.restartPhaseTimer();
    }
  }

  private hideCursor() {
    this.cursor.style.display = "none";
    this.cursor.classList.remove(VIRTUAL_CURSOR_PHASE_CLASS);
    if (this.phaseTimer !== null) {
      window.clearTimeout(this.phaseTimer);
      this.phaseTimer = null;
    }
  }

  private restartPhaseTimer() {
    this.cursor.classList.remove(VIRTUAL_CURSOR_PHASE_CLASS);
    if (this.phaseTimer !== null) {
      window.clearTimeout(this.phaseTimer);
    }
    this.phaseTimer = window.setTimeout(() => {
      this.cursor.classList.add(VIRTUAL_CURSOR_PHASE_CLASS);
      this.phaseTimer = null;
    }, PHASE_DELAY);
  }
}

export const virtualCursorExtension = ViewPlugin.fromClass(VirtualCursorView);
