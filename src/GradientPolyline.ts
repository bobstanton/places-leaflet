import { LineUtil, Polyline, type Bounds, type LatLng, type LatLngExpression, type Point, type PolylineOptions } from 'leaflet';

interface PolylineProjection {
  _rings: Point[][];
  _parts: Point[][];
  _pxBounds?: Bounds;
  _clipPoints(): void;
  _simplifyPoints(): void;
  _renderer: { _bounds: Bounds; _drawing: boolean; _ctx: CanvasRenderingContext2D; _updatePoly(layer: Polyline): void };
}

const projection = Polyline.prototype as unknown as PolylineProjection;

export class GradientPolyline extends Polyline {
  private strokeEnds: number[] = [];
  private strokeColors: string[] = [];

  constructor(latlngs: LatLngExpression[][], private readonly colors: readonly string[], options: PolylineOptions) {
    super(latlngs, options);
  }

  _projectLatlngs(latlngs: LatLng[][], rings: Point[][], bounds: Bounds): void {
    const crs = this._map.options.crs!;
    const zoom = this._map.getZoom();
    const origin = this._map.getPixelOrigin();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let previous: LatLng | undefined;
    let projected: Point;

    for (const segment of latlngs) {
      const ring = new Array<Point>(segment.length);

      for (let i = 0; i < segment.length; i++) {
        const coordinate = segment[i];

        if (!previous || coordinate.lat !== previous.lat || coordinate.lng !== previous.lng) {
          projected = crs.latLngToPoint(coordinate, zoom);
          projected.x = Math.round(projected.x) - origin.x;
          projected.y = Math.round(projected.y) - origin.y;
          if (projected.x < minX) minX = projected.x;
          if (projected.y < minY) minY = projected.y;
          if (projected.x > maxX) maxX = projected.x;
          if (projected.y > maxY) maxY = projected.y;
          previous = coordinate;
        }

        ring[i] = projected!;
      }

      rings.push(ring);
    }

    if (minX !== Infinity) {
      bounds.extend([minX, minY]);
      bounds.extend([maxX, maxY]);
    }
  }

  _update(): void {
    if (!this._map) return;
    const state = this as unknown as PolylineProjection;
    const rings = state._rings;
    const parts: Point[][] = [];

    this.strokeEnds = [];
    this.strokeColors = [];

    if (state._pxBounds?.intersects(state._renderer._bounds)) {
      for (let i = 0; i < rings.length; i++) {
        const ring = rings[i];

        if (ring.length === 2) {
          const segment = this.options.noClip ? ring : LineUtil.clipSegment(ring[0], ring[1], state._renderer._bounds, false, true);

          if (segment) {
            parts.push(segment);
            this.strokeEnds.push(parts.length);
            this.strokeColors.push(this.colors[i]);
          }
        } else {
          state._rings = [ring];
          projection._clipPoints.call(this);
          projection._simplifyPoints.call(this);

          if (state._parts.length) {
            for (const part of state._parts) parts.push(part);
            this.strokeEnds.push(parts.length);
            this.strokeColors.push(this.colors[i]);
          }
        }
      }
    }

    state._rings = rings;
    state._parts = parts;
    this._updatePath();
  }

  _updatePath(): void {
    const state = this as unknown as PolylineProjection;

    if (!this.options.fill) {
      const { _drawing, _ctx: ctx } = state._renderer;

      if (!_drawing || !this.options.stroke || this.options.weight === 0) return;
      const options = this.options as PolylineOptions & { _dashArray?: number[] };

      ctx.lineDashOffset = Number(options.dashOffset ?? 0);
      ctx.setLineDash(options._dashArray ?? []);
      ctx.globalAlpha = options.opacity!;
      ctx.lineWidth = options.weight!;
      ctx.lineCap = options.lineCap as CanvasLineCap;
      ctx.lineJoin = options.lineJoin as CanvasLineJoin;
      let firstPart = 0;

      for (let stroke = 0; stroke < this.strokeEnds.length; stroke++) {
        ctx.beginPath();
        const end = this.strokeEnds[stroke];

        for (let index = firstPart; index < end; index++) {
          const part = state._parts[index];

          if (!part.length) continue;
          ctx.moveTo(part[0].x, part[0].y);
          for (let i = 1; i < part.length; i++) ctx.lineTo(part[i].x, part[i].y);
        }

        ctx.strokeStyle = this.strokeColors[stroke];
        ctx.stroke();
        firstPart = end;
      }

      return;
    }

    const parts = state._parts;
    const color = this.options.color;

    try {
      let firstPart = 0;

      for (let stroke = 0; stroke < this.strokeEnds.length; stroke++) {
        const end = this.strokeEnds[stroke];

        state._parts = parts.slice(firstPart, end);
        this.options.color = this.strokeColors[stroke];
        state._renderer._updatePoly(this);
        firstPart = end;
      }
    } finally {
      state._parts = parts;
      this.options.color = color;
    }
  }
}
