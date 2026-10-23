import { RoleHome } from '@/components/RoleHome';
import { AdminOperations } from '@/components/AdminOperations';
import { AdminReviewQueue } from '@/components/AdminReviewQueue';
import { AdminTripBuilder } from '@/components/AdminTripBuilder';

export default function AdminHomeScreen() {
  return (
    <RoleHome title="Admin workspace">
      <AdminReviewQueue />
      <AdminOperations />
      <AdminTripBuilder />
    </RoleHome>
  );
}
