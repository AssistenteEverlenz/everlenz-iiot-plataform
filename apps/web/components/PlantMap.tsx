'use client';

import { useEffect, useMemo, useRef } from 'react';

export interface MapPlant {
  id: string;
  name: string;
  groupName?: string;
  state: string;
  location: {
    latitude: number | null;
    longitude: number | null;
    city: string | null;
    state: string | null;
  };
}
type LeafletMap = {
  remove(): void;
  fitBounds(points: [number, number][], options: object): void;
  setView(point: [number, number], zoom: number): void;
  getCenter(): { lat: number; lng: number };
  getZoom(): number;
};
type LeafletMarker = {
  addTo(map: LeafletMap): LeafletMarker;
  bindPopup(html: string): LeafletMarker;
  on(event: string, fn: () => void): LeafletMarker;
};
type Leaflet = {
  map(node: HTMLElement, options: object): LeafletMap;
  tileLayer(url: string, options: object): { addTo(map: LeafletMap): void };
  marker(point: [number, number], options: object): LeafletMarker;
  divIcon(options: object): unknown;
};
declare global {
  interface Window {
    L?: Leaflet;
    __iiotLeaflet?: Promise<void>;
  }
}

const COLORS: Record<string, string> = {
  producing: '#1fbf7a',
  idle: '#f2a93b',
  manual: '#e4572e',
  pause: '#cdb9ea',
  offline: '#98a6ab',
  unknown: '#98a6ab',
};
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (window.__iiotLeaflet) return window.__iiotLeaflet;
  window.__iiotLeaflet = new Promise((resolve, reject) => {
    if (!document.getElementById('leaflet-css')) {
      const link = document.createElement('link');
      link.id = 'leaflet-css';
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(link);
    }
    const old = document.getElementById('leaflet-js') as HTMLScriptElement | null;
    if (old) {
      old.addEventListener('load', () => resolve());
      old.addEventListener('error', () => reject(new Error('Mapa indisponível')));
      return;
    }
    const script = document.createElement('script');
    script.id = 'leaflet-js';
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Mapa indisponível'));
    document.body.appendChild(script);
  });
  return window.__iiotLeaflet;
}
function esc(value: string) {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
}
export function PlantMap({
  plants,
  selected,
  onSelect,
}: {
  plants: MapPlant[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const node = useRef<HTMLDivElement>(null);
  const instance = useRef<LeafletMap | null>(null);
  const viewport = useRef<{ center: [number, number]; zoom: number } | null>(null);
  const signature = useMemo(
    () => plants.map((plant) => `${plant.id}:${plant.state}:${plant.location.latitude}:${plant.location.longitude}`).join('|'),
    [plants],
  );
  useEffect(() => {
    let active = true;
    void loadLeaflet()
      .then(() => {
        if (!active || !node.current || !window.L) return;
        instance.current?.remove();
        const map = window.L.map(node.current, { zoomControl: true, scrollWheelZoom: true });
        instance.current = map;
        window.L.tileLayer(
          'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
          {
            maxZoom: 19,
            attribution: 'Tiles © Esri',
          },
        ).addTo(map);
        const points: [number, number][] = [];
        for (const plant of plants) {
          const { latitude, longitude } = plant.location;
          if (latitude == null || longitude == null) continue;
          const point: [number, number] = [latitude, longitude];
          points.push(point);
          const color = COLORS[plant.state] ?? COLORS.unknown;
          const icon = window.L.divIcon({
            className: 'plant-map-marker-wrap',
            html: `<button data-plant-id="${plant.id}" class="plant-map-marker ${selected === plant.id ? 'selected' : ''}" style="--pin:${color}" aria-label="${esc(plant.name)}"><span></span></button>`,
            iconSize: [18, 18],
            iconAnchor: [9, 9],
          });
          window.L.marker(point, { icon })
            .addTo(map)
            .bindPopup(
              `<strong>${esc(plant.name)}</strong><small>${esc([plant.groupName, plant.location.city, plant.location.state].filter(Boolean).join(' · '))}</small>`,
            )
            .on('click', () => onSelect(plant.id));
        }
        if (viewport.current) map.setView(viewport.current.center, viewport.current.zoom);
        else if (points.length === 0) map.setView([-14.2, -51.9], 4);
        else if (points.length === 1) map.setView(points[0], 11);
        else map.fitBounds(points, { padding: [45, 45], maxZoom: 12 });
      })
      .catch(() => undefined);
    return () => {
      active = false;
      if (instance.current) {
        const center = instance.current.getCenter();
        viewport.current = { center: [center.lat, center.lng], zoom: instance.current.getZoom() };
        instance.current.remove();
      }
      instance.current = null;
    };
  }, [signature, onSelect]);
  useEffect(() => {
    node.current?.querySelectorAll('.plant-map-marker').forEach((marker) => {
      marker.classList.toggle('selected', marker.getAttribute('data-plant-id') === selected);
    });
  }, [selected, signature]);
  return (
    <div className="plant-map" ref={node}>
      <span className="plant-map-loading">Carregando mapa…</span>
    </div>
  );
}
