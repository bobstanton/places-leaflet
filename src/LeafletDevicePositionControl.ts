import { Marker, DivIcon, type LeafletEvent, type Map as LeafletMap } from 'leaflet';
import { attachDevicePositionControl, createDevicePositionMarkerElement, updateDevicePositionMarkerHeading, type DevicePositionControlHandle } from "places-shared/obsidian/map";

type ZoomStartEvent = LeafletEvent & { originalEvent?: Event };

export function attachLeafletDevicePositionControl(map: LeafletMap, button: HTMLButtonElement): DevicePositionControlHandle {
  const document = map.getContainer().ownerDocument;
  let marker: Marker | null = null;
  let heading: number | null = null;
  let markerElement: HTMLElement | null = null;
  let disposed = false;

  const control = attachDevicePositionControl({
    button,
    geolocation: document.defaultView?.navigator.geolocation,
    adapter: {
      currentZoom: () => map.getZoom(),
      positionChanged: coordinate => {
        const latLng: [number, number] = [coordinate.latitude, coordinate.longitude];

        if (!marker) {
          markerElement = createDevicePositionMarkerElement();
          marker = new Marker(latLng, {
            icon: new DivIcon({ html: markerElement, className: '', iconSize: [20, 20], iconAnchor: [10, 10] }),
            interactive: false,
            keyboard: false,
          }).addTo(map);
        } else {
          marker.setLatLng(latLng);
        }

        if (markerElement) updateDevicePositionMarkerHeading(markerElement, heading);
      },
      headingChanged: value => {
        heading = value;
        if (markerElement) updateDevicePositionMarkerHeading(markerElement, heading);
      },
      positionRemoved: () => {
        marker?.remove();
        marker = null;
        markerElement = null;
      },
      recenter: (coordinate, zoom) => map.setView(
        [coordinate.latitude, coordinate.longitude],
        zoom ?? map.getZoom(),
        { animate: false },
      ),
      onUserMoveStart: handler => {
        const onDragStart = () => handler();
        const onZoomStart = (event: ZoomStartEvent) => {
          if (event.originalEvent) handler();
        };

        map.on('dragstart', onDragStart);
        map.on('zoomstart', onZoomStart);

        return () => {
          map.off('dragstart', onDragStart);
          map.off('zoomstart', onZoomStart);
        };
      },
    },
  });

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      control.dispose();
      marker?.remove();
      marker = null;
    },
  };
}
