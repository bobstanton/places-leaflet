export interface MarkerInfo {
  marker: unknown;
  labelElement: HTMLElement | null;
  // Same semantics as the vector layers' symbol-sort-key: lower is placed first and wins label collisions.
  labelSortKey?: number;
}

export interface MapInstance {
  on(event: string, handler: () => void): void;
  off(event: string, handler: () => void): void;
}

export class LabelVisibilityManager {
  // Horizontal spacing threshold in pixels between labels
  private static readonly LABEL_PADDING = 100;
  // Vertical spacing threshold in pixels between labels
  private static readonly LABEL_HEIGHT_THRESHOLD = 40;
  private static readonly HIDDEN_CLASS = 'places-marker-label-hidden';
  private static readonly labelVisibility = new WeakMap<HTMLElement, boolean>();

  private static setLabelVisible(labelElement: HTMLElement, visible: boolean): void {
    if (this.labelVisibility.get(labelElement) === visible) {
      return;
    }

    this.labelVisibility.set(labelElement, visible);
    labelElement.toggleClass(this.HIDDEN_CLASS, !visible);
  }

  private static updateLabelVisibilityCore<T extends MarkerInfo>(markers: T[], getMarkerPosition: (marker: T) => { x: number; y: number } | null): void {
    const cellW = this.LABEL_PADDING;
    const cellH = this.LABEL_HEIGHT_THRESHOLD;
    const grid = new Map<number, Array<{ x: number; y: number }>>();

    const toKey = (cx: number, cy: number) => cx * 10000 + cy;

    const ordered = [...markers].sort((a, b) => (a.labelSortKey ?? 0) - (b.labelSortKey ?? 0));

    for (const markerInfo of ordered) {
      if (!markerInfo.labelElement) continue;

      const position = getMarkerPosition(markerInfo);

      if (!position) {
        this.setLabelVisible(markerInfo.labelElement, false);
        continue;
      }

      const cx = Math.floor(position.x / cellW);
      const cy = Math.floor(position.y / cellH);

      let collides = false;

      for (let dx = -1; dx <= 1 && !collides; dx++) {
        for (let dy = -1; dy <= 1 && !collides; dy++) {
          const cell = grid.get(toKey(cx + dx, cy + dy));

          if (!cell) continue;

          for (let i = 0; i < cell.length; i++) {
            if (Math.abs(cell[i].x - position.x) < cellW && Math.abs(cell[i].y - position.y) < cellH) {
              collides = true;
              break;
            }
          }
        }
      }

      if (collides) {
        this.setLabelVisible(markerInfo.labelElement, false);
      } else {
        const key = toKey(cx, cy);
        const cell = grid.get(key);

        if (cell) cell.push(position);
        else grid.set(key, [position]);

        this.setLabelVisible(markerInfo.labelElement, true);
      }
    }
  }

  static setupLabelVisibility<T extends MarkerInfo>(map: MapInstance, markers: T[], getMarkerPosition: (marker: T) => { x: number; y: number } | null): () => void {
    let rafId = 0;
    let initialTimeoutId = 0;

    const scheduleUpdate = () => {
      if (rafId) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        this.updateLabelVisibilityCore(markers, getMarkerPosition);
      });
    };

    map.on('zoomend', scheduleUpdate);
    map.on('moveend', scheduleUpdate);

    initialTimeoutId = window.setTimeout(() => {
      initialTimeoutId = 0;
      this.updateLabelVisibilityCore(markers, getMarkerPosition);
    }, 100);

    return () => {
      map.off('zoomend', scheduleUpdate);
      map.off('moveend', scheduleUpdate);

      if (initialTimeoutId) {
        window.clearTimeout(initialTimeoutId);
        initialTimeoutId = 0;
      }

      if (rafId) {
        window.cancelAnimationFrame(rafId);
        rafId = 0;
      }
    };
  }

  static updateLabelsOnce<T extends MarkerInfo>(markers: T[], getMarkerPosition: (marker: T) => { x: number; y: number } | null): void {
    this.updateLabelVisibilityCore(markers, getMarkerPosition);
  }

  private static createPositionGetter(mapInstance: unknown, coordMethod: string, projectMethod: string) {
    return (markerInfo: { marker: unknown }) => {
      try {
        if (!mapInstance || typeof mapInstance !== 'object') return null;
        const map = mapInstance as Record<string, unknown>;
        const marker = markerInfo.marker as Record<string, unknown>;

        if (typeof marker[coordMethod] !== 'function') return null;
        const coord = (marker[coordMethod] as () => unknown)();

        if (typeof map.getBounds !== 'function') return null;
        const bounds = (map.getBounds as () => Record<string, unknown>)();

        if (typeof bounds.contains !== 'function') return null;
        if (!(bounds.contains as (c: unknown) => boolean)(coord)) return null;

        if (typeof map[projectMethod] !== 'function') return null;
        const point = (map[projectMethod] as (c: unknown) => { x: number; y: number })(coord);

        return { x: point.x, y: point.y };
      } catch {
        return null;
      }
    };
  }

  static createLeafletPositionGetter(leafletMap: unknown) {
    return this.createPositionGetter(leafletMap, 'getLatLng', 'latLngToContainerPoint');
  }
}
