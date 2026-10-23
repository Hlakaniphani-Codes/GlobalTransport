import { PassengerTabBar } from '@/components/PassengerTabBar';
import { PassengerRequestsList } from '@/components/RideRequests';
import { Screen } from '@/components/Screen';

export default function PassengerRequestsScreen() {
  return (
    <Screen bottomNavigation={<PassengerTabBar />} virtualized>
      <PassengerRequestsList />
    </Screen>
  );
}
