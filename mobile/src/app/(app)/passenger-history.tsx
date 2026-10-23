import { PassengerTabBar } from '@/components/PassengerTabBar';
import { PassengerTripHistory } from '@/components/PassengerTripHistory';
import { Screen } from '@/components/Screen';

export default function PassengerHistoryScreen() {
  return (
    <Screen bottomNavigation={<PassengerTabBar />} virtualized>
      <PassengerTripHistory />
    </Screen>
  );
}
