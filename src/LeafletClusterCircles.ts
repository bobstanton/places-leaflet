import { Map as LeafletMap, DivIcon, Marker, LatLng, LatLngBounds } from 'leaflet';

interface MarkerCluster {
  center: LatLng;
  markerIndices: number[];
  bounds: LatLngBounds;
}

export class LeafletClusterCircles {
  private markerDataList: readonly { latlng: LatLng }[] = [];
  private clusterMarkers: Marker[] = [];
  private active = false;
  private readonly redraw = () => { if (this.active) this.draw(); };

  constructor(private readonly map: LeafletMap, private readonly clusterRadius = 50) {
    map.on('moveend', this.redraw);
  }

  setMarkerData(dataList: readonly { latlng: LatLng }[]): void {
    this.markerDataList = dataList;
    this.redraw();
  }

  setActive(active: boolean): void {
    this.active = active;

    if (active) this.draw();
    else this.clear();
  }

  private clear(): void {
    this.clusterMarkers.forEach(marker => marker.remove());
    this.clusterMarkers = [];
  }

  private draw(): void {
    this.clear();

    for (const cluster of this.computeClusters()) {
      const clusterMarker = this.createClusterMarker(cluster);

      clusterMarker.addTo(this.map);
      this.clusterMarkers.push(clusterMarker);
    }
  }

  private computeClusters(): MarkerCluster[] {
    const clusters: MarkerCluster[] = [];
    const assigned = new Set<number>();
    const bounds = this.map.getBounds();
    const projected = new Map<number, { x: number; y: number }>();
    const cells = new Map<number, Map<number, number[]>>();
    const cellSize = Math.max(1, this.clusterRadius);

    this.markerDataList.forEach((data, index) => {
      if (bounds.contains(data.latlng)) {
        const point = this.map.latLngToContainerPoint(data.latlng);

        projected.set(index, point);
        const x = Math.floor(point.x / cellSize);
        const y = Math.floor(point.y / cellSize);
        let column = cells.get(x);

        if (!column) cells.set(x, column = new Map<number, number[]>());
        let cell = column.get(y);

        if (!cell) column.set(y, cell = []);
        cell.push(index);
      }
    });

    for (const [i, markerPoint] of projected) {
      if (assigned.has(i)) continue;

      const data = this.markerDataList[i];

      const cluster: MarkerCluster = {
        center: data.latlng,
        markerIndices: [i],
        bounds: new LatLngBounds(data.latlng, data.latlng)
      };

      assigned.add(i);

      const nearby: number[] = [];
      const x = Math.floor(markerPoint.x / cellSize);
      const y = Math.floor(markerPoint.y / cellSize);

      for (let dx = -1; dx <= 1; dx++) {
        const column = cells.get(x + dx);

        if (!column) continue;

        for (let dy = -1; dy <= 1; dy++) {
          for (const index of column.get(y + dy) ?? []) {
            if (!assigned.has(index)) nearby.push(index);
          }
        }
      }

      nearby.sort((a, b) => a - b);

      for (const j of nearby) {
        if (assigned.has(j)) continue;

        const otherData = this.markerDataList[j];
        const otherPoint = projected.get(j)!;

        const distance = Math.sqrt(
          Math.pow(markerPoint.x - otherPoint.x, 2) +
          Math.pow(markerPoint.y - otherPoint.y, 2)
        );

        if (distance <= this.clusterRadius) {
          cluster.markerIndices.push(j);
          cluster.bounds.extend(otherData.latlng);
          assigned.add(j);
        }
      }

      if (cluster.markerIndices.length > 1) {
        let totalLat = 0, totalLng = 0;

        cluster.markerIndices.forEach(idx => {
          const d = this.markerDataList[idx];

          totalLat += d.latlng.lat;
          totalLng += d.latlng.lng;
        });
        cluster.center = new LatLng(
          totalLat / cluster.markerIndices.length,
          totalLng / cluster.markerIndices.length
        );
      }

      clusters.push(cluster);
    }

    return clusters;
  }

  private createClusterMarker(cluster: MarkerCluster): Marker {
    const count = cluster.markerIndices.length;
    const size = Math.min(40 + Math.log10(count) * 10, 60);

    const icon = new DivIcon({
      className: 'places-cluster-marker',
      html: `<div class="places-cluster-icon" style="width: ${size}px; height: ${size}px; line-height: ${size}px;">${count}</div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2]
    });

    const marker = new Marker(cluster.center, { icon });

    marker.on('click', () => {
      this.map.fitBounds(cluster.bounds, { padding: [50, 50], animate: false });
    });

    return marker;
  }
}
