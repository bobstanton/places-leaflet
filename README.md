# Places - Leaflet

Map provider for [Places](https://community.obsidian.md/plugins/places) using [Leaflet](https://leafletjs.com/), with raster maps, custom tile layers, markers, tracks, and overlays.

This is not a stand-alone plugin, to use, install along side [Places](https://community.obsidian.md/plugins/places). Refer to the [sandbox](https://sandbox.obsidian.stanton.dev/places/) for examples.

## Network requests

| Area           | Request                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| Built-in style | Loads raster tiles from the tile server for the selected style: OpenStreetMap, OpenTopoMap, CartoDB, or Esri |
| Custom style   | Loads raster tiles from the XYZ tile URL set                                                                 |

## Background tasks

None.

## Dependencies

| Library                                                      | Purpose                                        |
| ------------------------------------------------------------ | ---------------------------------------------- |
| [Leaflet](https://github.com/Leaflet/Leaflet)                | Renders the map surface                        |
| [places-shared](https://github.com/bobstanton/places-shared) | Shared map, overlay, routing, and utility code |
