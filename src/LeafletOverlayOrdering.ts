import type { Map as LeafletMap } from 'leaflet';
import type { OverlayRenderBand } from "places-shared/overlay";

export const LEAFLET_BACKGROUND_OVERLAY_PANE = 'places-background-overlay-pane';
export const LEAFLET_BACKGROUND_OVERLAY_Z_INDEX = 350;

export function ensureLeafletOverlayPanes(map: LeafletMap): void {
  const pane = map.getPane(LEAFLET_BACKGROUND_OVERLAY_PANE)
    ?? map.createPane(LEAFLET_BACKGROUND_OVERLAY_PANE);

  pane.style.zIndex = String(LEAFLET_BACKGROUND_OVERLAY_Z_INDEX);
}

export function getLeafletOverlayPane(renderBand: OverlayRenderBand): string | undefined {
  return renderBand === 'background' ? LEAFLET_BACKGROUND_OVERLAY_PANE : undefined;
}
