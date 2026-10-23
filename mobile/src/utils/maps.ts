import { Linking } from 'react-native';

type MapStop = {
  address: string;
};

export function buildMapsUrl(stops: MapStop[]): string {
  const addresses = stops
    .map(({ address }) => address.trim())
    .filter((address) => address.length > 0);
  if (addresses.length === 0) {
    throw new Error('A stop address is required to open directions.');
  }
  if (addresses.length === 1) {
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addresses[0])}&travelmode=driving`;
  }

  const origin = encodeURIComponent(addresses[0]);
  const destination = encodeURIComponent(addresses[addresses.length - 1]);
  const waypoints = addresses
    .slice(1, -1)
    .map((address) => encodeURIComponent(address))
    .join('%7C');
  const waypointParameter = waypoints ? `&waypoints=${waypoints}` : '';
  return `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}${waypointParameter}&travelmode=driving`;
}

export async function openMapsDirections(stops: MapStop[]): Promise<void> {
  await Linking.openURL(buildMapsUrl(stops));
}
