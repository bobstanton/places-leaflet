import { Map as LeafletMap, DomUtil, LatLng, Point } from 'leaflet';
import { buildHeatmapRamp, heatmapRadius, heatmapWeight, heatmapIntensity, HEATMAP_GAUSSIAN_COEFFICIENT } from "places-shared/map";

const HIDDEN_CLASS = 'places-cluster-heatmap-hidden';
const RESOLUTION = 2;

export class LeafletClusterHeatmap {
  private readonly canvas: HTMLCanvasElement;
  private readonly ramp: Uint8ClampedArray;
  private markerDataList: readonly { latlng: LatLng; weight?: number }[] = [];
  private active = false;
  private readonly redraw = () => { if (this.active) this.draw(); };

  constructor(private readonly map: LeafletMap, colorScheme?: string) {
    this.ramp = buildHeatmapRamp(colorScheme);
    this.canvas = DomUtil.create('canvas', 'places-cluster-heatmap');
    this.canvas.addClass(HIDDEN_CLASS);
    map.getPanes().overlayPane.appendChild(this.canvas);
    map.on('moveend', this.redraw);
    map.on('resize', this.redraw);
    map.on('unload', this.destroy);
  }

  setMarkerData(dataList: readonly { latlng: LatLng; weight?: number }[]): void {
    this.markerDataList = dataList;
    this.redraw();
  }

  setActive(active: boolean): void {
    this.active = active;

    if (active) this.draw();
    else this.canvas.addClass(HIDDEN_CLASS);
  }

  readonly destroy = (): void => {
    this.active = false;
    this.map.off('moveend', this.redraw);
    this.map.off('resize', this.redraw);
    this.map.off('unload', this.destroy);
    this.canvas.remove();
  };

  pointsNear(containerPoint: Point, radiusPx: number): number[] {
    const near: Array<{ index: number; distance: number }> = [];

    this.markerDataList.forEach((data, index) => {
      const distance = this.project(data.latlng).distanceTo(containerPoint);

      if (distance <= radiusPx) near.push({ index, distance });
    });

    return near.sort((left, right) => left.distance - right.distance).map(entry => entry.index);
  }

  private project(latlng: LatLng): Point {
    const center = this.map.getCenter().lng;
    const longitude = latlng.lng + 360 * Math.round((center - latlng.lng) / 360);

    return this.map.latLngToContainerPoint(new LatLng(latlng.lat, longitude));
  }

  private draw(): void {
    const size = this.map.getSize();

    if (size.x <= 0 || size.y <= 0) return;

    this.canvas.removeClass(HIDDEN_CLASS);
    const width = Math.ceil(size.x / RESOLUTION);
    const height = Math.ceil(size.y / RESOLUTION);

    this.canvas.width = width;
    this.canvas.height = height;
    this.canvas.style.width = `${size.x}px`;
    this.canvas.style.height = `${size.y}px`;
    DomUtil.setPosition(this.canvas, this.map.containerPointToLayerPoint(new Point(0, 0)));

    const context = this.canvas.getContext('2d');

    if (!context) return;
    const density = new Float32Array(width * height);
    const zoom = this.map.getZoom() - 1;
    const intensity = heatmapIntensity(zoom);
    const radius = heatmapRadius(zoom) / RESOLUTION;
    const extent = Math.ceil(radius * 1.5);
    const kernel = new Float32Array(extent * 2 + 1);

    for (let offset = -extent; offset <= extent; offset++) {
      kernel[offset + extent] = Math.exp(-4.5 * (offset / radius) ** 2);
    }

    for (const data of this.markerDataList) {
      const point = this.project(data.latlng);
      const x = Math.round(point.x / RESOLUTION);
      const y = Math.round(point.y / RESOLUTION);

      if (x + extent < 0 || y + extent < 0 || x - extent >= width || y - extent >= height) continue;
      const weight = heatmapWeight(data.weight ?? 1) * intensity * HEATMAP_GAUSSIAN_COEFFICIENT;

      for (let row = Math.max(0, y - extent); row <= Math.min(height - 1, y + extent); row++) {
        const contribution = weight * kernel[row - y + extent];

        for (let column = Math.max(0, x - extent); column <= Math.min(width - 1, x + extent); column++) {
          density[row * width + column] += contribution * kernel[column - x + extent];
        }
      }
    }

    const image = context.createImageData(width, height);

    for (let index = 0; index < density.length; index++) {
      const position = Math.min(255, Math.max(0, density[index] * 256 - 0.5));
      const low = Math.floor(position);
      const high = Math.min(255, low + 1);
      const fraction = position - low;

      for (let channel = 0; channel < 4; channel++) {
        const start = this.ramp[low * 4 + channel];

        image.data[index * 4 + channel] = start + (this.ramp[high * 4 + channel] - start) * fraction;
      }
    }

    context.putImageData(image, 0, 0);
  }
}
