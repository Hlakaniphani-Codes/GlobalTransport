import { StyleSheet, View } from 'react-native';

import { theme } from '@/theme';

export function TransportIllustration() {
  return (
    <View
      accessible
      accessibilityLabel="Illustration of a Global Ride shuttle travelling along a route"
      style={styles.scene}
    >
      <View style={styles.halo} />
      <View style={styles.route} />
      <View style={[styles.routeStop, styles.startStop]} />
      <View style={[styles.routeStop, styles.endStop]} />
      <View style={styles.road}>
        <View style={styles.roadDash} />
        <View style={[styles.roadDash, styles.dashMiddle]} />
        <View style={[styles.roadDash, styles.dashRight]} />
      </View>
      <View style={styles.shuttle}>
        <View style={styles.windshield} />
        <View style={styles.window} />
        <View style={styles.windowBack} />
        <View style={styles.shuttleStripe} />
        <View style={styles.wheelFront} />
        <View style={styles.wheelBack} />
      </View>
      <View style={styles.sparkleOne} />
      <View style={styles.sparkleTwo} />
    </View>
  );
}

const styles = StyleSheet.create({
  scene: {
    height: 188,
    overflow: 'hidden',
    justifyContent: 'flex-end',
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.navy,
  },
  halo: {
    position: 'absolute',
    top: -92,
    right: -25,
    width: 230,
    height: 230,
    borderWidth: 1,
    borderColor: '#31516A',
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.navySoft,
  },
  route: {
    position: 'absolute',
    left: 26,
    right: 26,
    top: 76,
    height: 2,
    backgroundColor: '#557087',
    transform: [{ rotate: '-12deg' }],
  },
  routeStop: {
    position: 'absolute',
    zIndex: 1,
    top: 65,
    width: 12,
    height: 12,
    borderWidth: 3,
    borderColor: theme.colors.accent,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.navy,
  },
  startStop: {
    left: 34,
  },
  endStop: {
    right: 34,
    top: 42,
  },
  road: {
    position: 'absolute',
    right: -24,
    bottom: 7,
    left: -24,
    height: 45,
    borderTopWidth: 2,
    borderColor: '#466179',
    backgroundColor: '#0D263B',
  },
  roadDash: {
    position: 'absolute',
    top: 20,
    left: 26,
    width: 34,
    height: 3,
    borderRadius: 2,
    backgroundColor: '#718697',
  },
  dashMiddle: {
    left: '47%',
  },
  dashRight: {
    right: 26,
    left: undefined,
  },
  shuttle: {
    position: 'absolute',
    bottom: 37,
    left: '50%',
    width: 190,
    height: 74,
    marginLeft: -95,
    borderWidth: 2,
    borderColor: '#D9E8F3',
    borderRadius: 16,
    borderBottomRightRadius: 22,
    backgroundColor: theme.colors.white,
    transform: [{ rotate: '-2deg' }],
  },
  windshield: {
    position: 'absolute',
    top: 10,
    right: 9,
    width: 37,
    height: 32,
    borderTopRightRadius: 12,
    borderBottomLeftRadius: 8,
    backgroundColor: '#B9DDF2',
  },
  window: {
    position: 'absolute',
    top: 10,
    right: 53,
    width: 35,
    height: 32,
    borderRadius: 6,
    backgroundColor: '#B9DDF2',
  },
  windowBack: {
    position: 'absolute',
    top: 10,
    left: 11,
    width: 35,
    height: 32,
    borderRadius: 6,
    backgroundColor: '#B9DDF2',
  },
  shuttleStripe: {
    position: 'absolute',
    right: 0,
    bottom: 15,
    left: 0,
    height: 7,
    backgroundColor: theme.colors.primary,
  },
  wheelFront: {
    position: 'absolute',
    bottom: -11,
    left: 28,
    width: 22,
    height: 22,
    borderWidth: 5,
    borderColor: '#D9E8F3',
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.navy,
  },
  wheelBack: {
    position: 'absolute',
    right: 25,
    bottom: -11,
    width: 22,
    height: 22,
    borderWidth: 5,
    borderColor: '#D9E8F3',
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.navy,
  },
  sparkleOne: {
    position: 'absolute',
    top: 35,
    left: '34%',
    width: 6,
    height: 6,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.accent,
  },
  sparkleTwo: {
    position: 'absolute',
    top: 96,
    right: '20%',
    width: 4,
    height: 4,
    borderRadius: theme.radius.pill,
    backgroundColor: '#9BC7E3',
  },
});
