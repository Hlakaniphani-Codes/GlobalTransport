import { Link } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { AppText as Text } from '@/components/AppText';
import { theme } from '@/theme';

type AuthLinkProps = {
  prompt: string;
  label: string;
  href: '/login' | '/signup-driver' | '/signup-passenger' | '/(auth)';
};

export function AuthLink({ prompt, label, href }: AuthLinkProps) {
  return (
    <View style={styles.row}>
      {prompt ? <Text style={styles.prompt}>{prompt} </Text> : null}
      <Link href={href} style={styles.link}>
        {label}
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  prompt: {
    color: theme.colors.textSecondary,
    fontSize: 15,
  },
  link: {
    color: theme.colors.primary,
    fontSize: 15,
    fontWeight: '700',
  },
});
