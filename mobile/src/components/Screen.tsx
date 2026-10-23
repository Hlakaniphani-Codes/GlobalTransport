import {
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
  type RefreshControlProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { PropsWithChildren, ReactNode } from 'react';

import { useBreakpoint } from '@/hooks/useBreakpoint';
import { theme } from '@/theme';

type ScreenProps = PropsWithChildren<{
  contentContainerStyle?: StyleProp<ViewStyle>;
  card?: boolean;
  virtualized?: boolean;
  footer?: ReactNode;
  bottomNavigation?: ReactNode;
  refreshing?: boolean;
  onRefresh?: RefreshControlProps['onRefresh'];
}>;

export function Screen({
  children,
  contentContainerStyle,
  card = false,
  virtualized = false,
  footer,
  bottomNavigation,
  refreshing = false,
  onRefresh,
}: ScreenProps) {
  const breakpoint = useBreakpoint();

  return (
    <SafeAreaView
      edges={['top', 'bottom']}
      style={[styles.safeArea, bottomNavigation ? styles.safeAreaWithNavigation : null]}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboard}
      >
        {virtualized ? (
          <View style={[styles.virtualizedContent, breakpoint === 'compact' && styles.compactVirtualizedContent]}>
            {children}
          </View>
        ) : (
          <ScrollView
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            refreshControl={onRefresh ? (
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.primary} />
            ) : undefined}
            contentContainerStyle={[
              styles.scrollContent,
              breakpoint === 'compact' && styles.compactScrollContent,
              contentContainerStyle,
            ]}
          >
            <View style={[styles.content, card && styles.card]}>{children}</View>
          </ScrollView>
        )}
        {footer ? (
          <View style={styles.footer}>
            <View style={styles.footerContent}>{footer}</View>
          </View>
        ) : null}
        {bottomNavigation ? (
          <View style={styles.bottomNavigation}>{bottomNavigation}</View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  safeAreaWithNavigation: {
    backgroundColor: theme.colors.white,
  },
  keyboard: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 28,
  },
  content: {
    width: '100%',
    maxWidth: 480,
    gap: 20,
  },
  virtualizedContent: {
    flex: 1,
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
  },
  compactVirtualizedContent: {
    paddingHorizontal: theme.spacing.sm,
  },
  compactScrollContent: {
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 20,
  },
  card: {
    padding: theme.spacing.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 24,
    backgroundColor: theme.colors.surface,
    shadowColor: theme.colors.navy,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.05,
    shadowRadius: 18,
    elevation: 1,
  },
  footer: {
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.white,
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.sm,
  },
  footerContent: {
    width: '100%',
    maxWidth: 560,
    gap: theme.spacing.sm,
  },
  bottomNavigation: {
    alignItems: 'center',
    backgroundColor: theme.colors.white,
  },
});
