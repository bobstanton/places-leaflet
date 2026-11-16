import { Canvas, Renderer, type Bounds, type Point } from 'leaflet';

interface CanvasLayout {
  _container: HTMLCanvasElement;
  _bounds?: Bounds;
  _ctxScale: number;
  _resizeContainer(): Point;
  _update(): void;
}

// Leaflet 2 alpha resizes after drawing on moveend. Assigning the bitmap size
// clears that drawing even when the dimensions have not changed.
export class TrackCanvas extends Canvas {
  _resizeContainer(): Point {
    const state = this as unknown as CanvasLayout;
    const size = (Renderer.prototype as unknown as CanvasLayout)._resizeContainer.call(this);
    const scale = window.devicePixelRatio;
    const width = Math.floor(scale * size.x), height = Math.floor(scale * size.y);
    const changed = state._container.width !== width || state._container.height !== height;

    state._ctxScale = scale;

    if (changed) {
      state._container.width = width;
      state._container.height = height;
      if (state._bounds) state._update();
    }

    return size;
  }
}
