import { CircleMarker, LayerGroup, Marker, Path, Point, type Layer, type LeafletMouseEvent, type Map as LeafletMap } from 'leaflet';
import { createMapHit, createOverlayPointHit, orderMapHits, type MapHit, type MapHitKind } from "places-shared/map";
import type { MapPlace } from "places-shared/overlay";
import type * as GeoJson from 'geojson';

export interface LeafletHitTarget {
  place?: MapPlace;
  feature?: GeoJson.Feature;
  sourcePath?: string;
}

interface Registration {
  layer: Layer;
  kind: MapHitKind;
  resolve: (leaf: Layer) => LeafletHitTarget | undefined;
}

const PATH_TOLERANCE_PX = 5;

interface PathHitTest {
  _containsPoint(point: Point, closed?: boolean): boolean;
}

export class LeafletHitRegistry {
  private readonly registrations = new WeakMap<LeafletMap, Set<Registration>>();
  private readonly proximitySources = new WeakMap<LeafletMap, (event: LeafletMouseEvent) => MapPlace[]>();

  setProximitySource(map: LeafletMap, resolve: (event: LeafletMouseEvent) => MapPlace[]): void {
    this.proximitySources.set(map, resolve);
  }

  clearProximitySource(map: LeafletMap): void {
    this.proximitySources.delete(map);
  }

  register(map: LeafletMap, layer: Layer, kind: MapHitKind, resolve: (leaf: Layer) => LeafletHitTarget | undefined): void {
    let entries = this.registrations.get(map);

    if (!entries) {
      entries = new Set<Registration>();
      this.registrations.set(map, entries);
    }

    const registration: Registration = { layer, kind, resolve };

    entries.add(registration);
    layer.once('remove', () => entries.delete(registration));
  }

  collect(map: LeafletMap, event: LeafletMouseEvent): MapHit[] {
    const hits: MapHit[] = [];
    let order = 0;

    for (const place of this.proximitySources.get(map)?.(event) ?? []) {
      hits.push(createMapHit('marker', place, order));
      order += 1;
    }

    const entries = this.registrations.get(map);

    if (!entries || entries.size === 0) return orderMapHits(hits);

    const clicked: unknown = event.propagatedFrom ?? event.target;

    for (const registration of entries) {
      if (!map.hasLayer(registration.layer)) continue;

      for (const leaf of leavesOf(registration.layer)) {
        if (leaf !== clicked && !containsPoint(map, leaf, event)) continue;

        const target = registration.resolve(leaf);

        if (!target) continue;

        const hit = target.feature
          ? createOverlayPointHit(target.feature, order, target.sourcePath)
          : target.place && createMapHit(registration.kind, target.place, order);

        if (hit) {
          hits.push(hit);
          order += 1;
        }
      }
    }

    return orderMapHits(hits);
  }
}

function leavesOf(layer: Layer): Layer[] {
  if (!(layer instanceof LayerGroup)) return [layer];

  const leaves: Layer[] = [];

  layer.eachLayer(child => leaves.push(...leavesOf(child)));

  return leaves;
}

function containsPoint(map: LeafletMap, layer: Layer, event: LeafletMouseEvent): boolean {
  if (layer instanceof Marker) {
    const element = layer.getElement();

    if (!element) return false;
    const box = element.getBoundingClientRect();

    if (box.width <= 0 || box.height <= 0) return false;
    const { clientX, clientY } = event.originalEvent;

    return clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom;
  }

  if (layer instanceof CircleMarker) {
    const point = event.containerPoint;

    if (!point) return false;
    const center = map.latLngToContainerPoint(layer.getLatLng());
    const reach = layer.getRadius() + (layer.options.weight ?? 0) / 2 + PATH_TOLERANCE_PX;

    return center.distanceTo(point) <= reach;
  }

  if (layer instanceof Path) {
    const path = layer as unknown as Partial<PathHitTest>;

    if (typeof path._containsPoint !== 'function') return false;

    const point = event.layerPoint;

    if (!point) return false;
    const probes = [
      point,
      new Point(point.x - PATH_TOLERANCE_PX, point.y),
      new Point(point.x + PATH_TOLERANCE_PX, point.y),
      new Point(point.x, point.y - PATH_TOLERANCE_PX),
      new Point(point.x, point.y + PATH_TOLERANCE_PX),
    ];

    return probes.some(probe => path._containsPoint!(probe));
  }

  return false;
}
