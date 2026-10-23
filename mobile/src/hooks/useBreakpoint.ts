import { useWindowDimensions } from 'react-native';

export type Breakpoint = 'compact' | 'regular' | 'large';

export function useBreakpoint(): Breakpoint {
  const { width } = useWindowDimensions();
  if (width < 360) return 'compact';
  if (width < 430) return 'regular';
  return 'large';
}
