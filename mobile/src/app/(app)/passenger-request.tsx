import { PassengerTabBar } from '@/components/PassengerTabBar';
import { PassengerRideRequestForm } from '@/components/RideRequests';
import { Screen } from '@/components/Screen';

export default function PassengerRequestScreen() {
  return (
    <Screen bottomNavigation={<PassengerTabBar />}>
      <PassengerRideRequestForm />
    </Screen>
  );
}
