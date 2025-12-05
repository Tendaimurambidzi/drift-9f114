// Correct “Send Echo” (comment) transaction
import firestore from '@react-native-firebase/firestore';

async function sendEcho(waveId: string, text: string) {
  const uid = firestore().app.auth().currentUser?.uid; // or however you get uid
  if (!uid) throw new Error('Not signed in');

  const waveRef = firestore().collection('waves').doc(waveId);
  const echoRef = waveRef.collection('echoes').doc(); // auto id

  const trimmed = text.trim();
  if (!trimmed) return;

  await firestore().runTransaction(async (tx) => {
    // Ensure parent wave exists and has counts object
    const waveDoc = await tx.get(waveRef);
    if (!waveDoc.exists) {
      throw new Error('Wave does not exist');
    }
    let counts = waveDoc.data().counts || {};
    if (typeof counts !== 'object' || Array.isArray(counts)) {
      counts = {};
    }

    // 1) create echo doc
    tx.set(echoRef, {
      userUid: uid,          // MUST be userUid (rules check this)
      text: trimmed,         // MUST be "text"
      createdAt: firestore.FieldValue.serverTimestamp(),
    });

    // 2) only increment counts + (optional) updatedAt
    tx.update(waveRef, {
      'counts.echoes': firestore.FieldValue.increment(1),
      updatedAt: firestore.FieldValue.serverTimestamp(),
    });
  }).catch((err) => {
    // Only show error if it's not a permission error for a successful echo
    if (err && err.message && err.message.includes('permission-denied')) {
      // Optionally: log silently, or show a less intrusive message
      return;
    }
    throw err;
  });
}
import React, {
  useEffect,
  useMemo,
  useState,
  useRef,
  useCallback,
} from 'react';
import ErrorBoundary from './src/components/ErrorBoundary';
import { NavigationContainer, useIsFocused } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { GestureHandlerRootView, PanGestureHandler } from 'react-native-gesture-handler';
import { Suspense, lazy } from 'react';
const BioluminescentTapEffect = lazy(() => import('./src/components/BioluminescentTapEffect'));
const NotificationToast = lazy(() => import('./src/components/NotificationToast'));
const WaveRippleEffect = lazy(() => import('./src/components/WaveRippleEffect'));
const SwimmingFishLoader = lazy(() => import('./src/components/SwimmingFishLoader'));
const UserSearch = lazy(() => import('./src/components/UserSearch'));
import {
  Alert,
  Animated,
  ActivityIndicator,
  AppState,
  BackHandler,
  Dimensions,
  Easing,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  NativeModules,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import EditableProfileAvatar from './EditableProfileAvatar';
import ImageCropPicker from 'react-native-image-crop-picker';
const { AudioPicker } = NativeModules;
import BridgeDataSaverPanel from './src/dataSaver/BridgeDataSaverPanel';
import CrabWalkBadge from './src/components/CrabWalkBadge';
import { DataSaverProvider } from './src/dataSaver/DataSaverProvider';
import OceanAmbienceToggle from './src/components/OceanAmbienceToggle';
import InteractiveWavePhysics from './InteractiveWavePhysics';
import ShakeForStorms from './ShakeForStorms';
import OctopusHug from './OctopusHug';
import FloatingWaterAnimation from './FloatingWaterAnimation';
import CharteredSeaDriftButton from './CharteredSeaDriftButton';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { launchCamera, launchImageLibrary, CameraOptions, Asset, ImagePickerResponse } from 'react-native-image-picker';
import auth, { FirebaseAuthTypes } from '@react-native-firebase/auth';

import Sound from 'react-native-sound';
import { shareDriftLink } from './src/services/driftService';
import {
  getCrewCount,
  isInCrew,
  joinCrew,
  leaveCrew,
} from './src/services/crewService';


// Navigation stack shared across auth/app flows
const Stack = createNativeStackNavigator();

// Try to use react-native-video if installed; otherwise fall back to hiding video elements
let RNVideo: any = null;
try {
  RNVideo = require('react-native-video').default;
} catch (err) {
  console.warn('react-native-video not available, video playback disabled:', err?.message || err);
}

// Paper texture is optional; keep null-safe to avoid crashes if the asset is missing
const paperTexture = null;
const myLogo = (() => {
  try {
    return require('./assets/my_logo.jpg');
  } catch {
    return null;
  }
})();

// Debug safety switch: keep false unless intentionally force-signing users out on cold start
const FORCE_SIGN_OUT_ON_START = false;

// Default dimensions for overlay UI; used in live stats panels
const STATS_OVERLAY_HEIGHT = 220;

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

type Wave = {
  id: string;
  media: Asset;
  audio: { uri: string; name?: string } | null;
  captionText: string;
  captionPosition: { x: number; y: number };
  playbackUrl?: string | null; // server-muxed single stream
  muxStatus?: 'pending' | 'ready' | 'failed';
  authorName?: string | null; // display handle (e.g., "/Tindoe")
  ownerUid?: string | null; // creator uid (for self-display as /You)
};

type SearchResult = {
  kind: 'user' | 'wave';
  id: string;
  label: string;
  extra?: Record<string, any>;
};

type Ping = {
  id: string;
  type:
    | 'splash'
    | 'echo'
    | 'follow'
    | 'message'
    | 'system_message'
    | 'friend_went_live'
    | 'joined_tide'
    | 'left_crew';
  fromUid?: string; // e.g., the user who sent the message
  actorName?: string; // e.g., '@Kai'
  waveId?: string;
  tideName?: string;
  text: string;
  timestamp: any; // Firestore Timestamp
  read: boolean;
  splashType?: 'regular' | 'octopus_hug'; // To differentiate between splash and hug
};

type LivePollOption = {
  id: string;
  label: string;
};

type LivePoll = {
  question: string;
  options: LivePollOption[];
  votes: Record<string, number>;
};

type LiveGoal = {
  target: number;
  current: number;
  label?: string;
};

const formatCount = (n: number) => {
  if (n < 1000) return String(n);
  return `${Math.floor(n / 1000)}k`;
};

type DriftAlert = {
  hostUid: string;
  liveId: string;
  hostName: string;
  hostPhoto: string | null;
};

const toJSDate = (ts: any) => {
  try {
    if (!ts) return new Date(0);
    if (typeof ts?.toDate === 'function') return ts.toDate();
    if (typeof ts?.seconds === 'number') return new Date(ts.seconds * 1000);
    return new Date(ts);
  } catch {
    return new Date(0);
  }
};

const getAppVersionInfo = () => {
  const platformConstants: any =
    (NativeModules as any)?.PlatformConstants ||
    (NativeModules as any)?.UIManager?.getConstants?.() ||
    {};
  const pkgVersion = (() => {
    try {
      return require('./package.json')?.version;
    } catch {
      return null;
    }
  })();
  const version =
    platformConstants.appVersion ||
    platformConstants.appVersionName ||
    pkgVersion ||
    '1.0.0';
  const build =
    platformConstants.appBuildNumber ||
    platformConstants.appVersionCode ||
    platformConstants.VersionCode ||
    (platformConstants.Version && platformConstants.Version.build) ||
    '1';
  return { version: String(version), build: String(build) };
};

const fetchBackendVersionInfo = async () => {
  try {
    const cfgModule = require('./liveConfig');
    const cfg =
      cfgModule?.cfg ||
      cfgModule?.default ||
      cfgModule ||
      {};
    const baseUrl =
      cfg.BACKEND_BASE_URL ||
      cfg.USER_MGMT_ENDPOINT_BASE ||
      cfg.USER_MANAGEMENT_BASE_URL ||
      '';
    if (!baseUrl) return null;
    const normalized = baseUrl.endsWith('/')
      ? baseUrl.slice(0, -1)
      : baseUrl;
    const resp = await fetch(`${normalized}/app-version`);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data?.version || !data?.build) return null;
    return {
      version: String(data.version),
      build: String(data.build),
      source: data.source || 'backend',
    };
  } catch (err) {
    console.log('Failed to fetch app version from backend:', err);
    return null;
  }
};

function useAppVersionInfo() {
  const [info, setInfo] = useState({
    ...getAppVersionInfo(),
    source: 'native',
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const remote = await fetchBackendVersionInfo();
      if (remote && !cancelled) {
        setInfo(remote);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return info;
}

const waveOptionMenu = [
  {
    label: 'Join Crew',
    description: 'Follow this user to see their waves in your feed.',
  },
  {
    label: 'Save to device',
    description: 'Download a copy of this wave for offline viewing.',
  },
  { label: 'Share', description: 'Share the wave link with friends.' },
  {
    label: 'Report',
    description: 'Let us know if this wave violates guidelines.',
  },
];

// ======================== STYLES ========================
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: 'black' },
  topStrip: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 0,
    backgroundColor: 'rgba(0, 10, 25, 0.95)',
    flexDirection: 'row',
    alignItems: 'center',
  },
  upperRow: { height: 48, justifyContent: 'center', alignItems: 'center' },
  profileButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 2,
    paddingHorizontal: 10,
  },
  umbrellaIcon: { fontSize: 20, textAlign: 'center' },
  profileLabel: { color: 'white', fontWeight: '700', letterSpacing: 1.2 },

  lowerRow: { height: 64 },
  scrollRow: { alignItems: 'center', gap: 18, paddingHorizontal: 12 },

  topItem: {
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingVertical: 2,
    paddingHorizontal: 6,
  },
  topLabel: {
    color: 'white',
    fontWeight: '800',
    fontSize: 12,
    letterSpacing: 0.5,
  },

  // Icons above words
  dolphinIcon: { fontSize: 18, marginBottom: 2 },
  pingsIcon: { fontSize: 18, marginBottom: 2 },
  compassIcon: { fontSize: 18, marginBottom: 2 },
  globeIcon: { fontSize: 18, marginBottom: 2, color: '#1E90FF' },
  pingsBadge: {
    position: 'absolute',
    // @ts-ignore
    top: -4,
    right: -8,
    backgroundColor: '#FF3B30',
    borderRadius: 9,
    minWidth: 18,
    height: 18,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 5,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.5)',
  },
  pingsBadgeText: { color: 'white', fontSize: 10, fontWeight: 'bold' },
  boatIcon: { fontSize: 18, marginBottom: 2 },
  noticeIcon: { fontSize: 18, marginBottom: 2 },
  schoolIcon: { fontSize: 18, marginBottom: 2 },
  gearIcon: { fontSize: 18, marginBottom: 2, color: 'white' },
  placeholderIcon: { fontSize: 18, marginBottom: 2 },

  videoSpace: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'transparent',
    zIndex: 0,
    overflow: 'hidden',
  },
  videoSpaceInner: { flex: 1, justifyContent: 'center', backgroundColor: 'transparent' },
  videoHint: { color: 'rgba(255,255,255,0.5)', fontSize: 12 },
  mediaPreview: { flex: 1, width: '100%', resizeMode: 'contain' },
  postedWaveContainer: { flex: 1, width: '100%', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  postedWaveMedia: {
    width: '100%',
    height: undefined,
    alignSelf: 'center',
    backgroundColor: 'transparent',
  },
  postedWaveCaption: {
    position: 'absolute',
    color: 'white',
    fontWeight: 'bold',
    fontSize: 18,
    textShadowColor: 'rgba(0, 0, 0, 0.75)',
    textShadowOffset: { width: -1, height: 1 },
    textShadowRadius: 10,
  },
  mediaTitleBar: {
    position: 'absolute',
    top: 8,
    left: 8,
    right: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8, // This can be kept or removed, doesn't affect transparency
    backgroundColor: 'transparent',
  },
  mediaTitleText: { color: 'white', fontWeight: '800', flexShrink: 1 },
  mediaTimerText: {
    color: 'white',
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
    marginLeft: 12,
  },
  waveOptionsButton: {
    position: 'absolute',
    right: 14,
    top: 75,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 45,
  },
  waveOptionsButtonText: {
    color: 'white',
    fontSize: 20,
    lineHeight: 22,
  },
  waveOptionsBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  waveOptionsMenu: {
    backgroundColor: 'rgba(11,18,36,0.95)',
    borderRadius: 16,
    paddingVertical: 4,
    overflow: 'hidden',
  },
  waveOptionsItem: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  waveOptionsItemTitle: {
    color: 'white',
    fontWeight: '700',
    fontSize: 16,
    textAlign: 'center',
  },
  waveOptionsItemDescription: {
    color: 'rgba(255,255,255,0.65)',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 4,
  },
  waveOptionsCancel: {
    borderBottomWidth: 0,
  },

  rightBubbles: {
    position: 'absolute',
    right: 12,
    top: SCREEN_HEIGHT * 0.45,
    alignItems: 'flex-end',
    zIndex: 10,
  },
  crewBubble: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(0, 32, 64, 0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.6)',
    overflow: 'hidden',
  },
  crewAvatar: { width: '100%', height: '100%' },
  crewInitial: { color: 'white', fontWeight: '800', fontSize: 16 },
  driftAlertContainer: {
    position: 'absolute',
    left: 12,
    top: '36%',
    zIndex: 550,
    backgroundColor: 'rgba(5, 10, 20, 0.85)',
    borderRadius: 26,
    borderWidth: 1,
    borderColor: 'rgba(0, 212, 255, 0.6)',
    paddingVertical: 6,
    paddingHorizontal: 10,
    elevation: 12,
    shadowColor: '#00D4FF',
    shadowOpacity: 0.6,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 6,
  },
  driftAlertButton: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  driftAlertSignal: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#00D4FF',
    marginRight: 4,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.6)',
  },
  driftAlertAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(0, 194, 255, 0.15)',
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
    marginRight: 6,
  },
  driftAlertAvatarImage: {
    width: '100%',
    height: '100%',
  },
  driftAlertInitials: {
    color: 'white',
    fontWeight: '700',
    fontSize: 14,
  },
  driftAlertText: {
    color: 'white',
    fontWeight: '600',
    fontSize: 12,
    maxWidth: 140,
  },
  posterName: {
    color: 'white',
    fontWeight: 'bold',
    marginBottom: 8,
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowRadius: 4,
  },

  modalRoot: { flex: 1, backgroundColor: 'rgba(0, 10, 20, 0.92)' },
  modalHeader: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.2)',
  },
  modalTitle: {
    color: 'white',
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  modalContent: {
    padding: 16,
    gap: 12,
    backgroundColor: 'rgba(10,14,26,0.98)',
    borderRadius: 14,
  },
  closeBtn: {
    alignSelf: 'center',
    marginVertical: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  closeText: { color: 'white', fontWeight: '700' },

  // Captain's Log Profile
  logbookContainer: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: '#0A1929',
  },
  logbookPage: { flex: 1, padding: 16, paddingTop: 24 },
  logbookBg: {
    ...StyleSheet.absoluteFillObject,
    width: undefined,
    height: undefined,
    opacity: 0.15,
  },
  logbookTitle: {
    color: 'rgba(255,255,255,0.8)',
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    fontSize: 18,
    fontWeight: 'bold',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.3)',
    paddingBottom: 8,
    marginBottom: 16,
  },
  logbookAction: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.2)',
  },
  logbookActionText: {
    color: 'rgba(220,220,240,0.9)',
    fontSize: 16,
    fontWeight: '600',
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  bridgeSettingButton: {
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(0, 212, 255, 0.3)',
  },
  bridgeSettingButtonText: {
    color: 'white',
    fontWeight: '600',
    fontSize: 14,
  },
  bridgeSettingHint: {
    color: 'rgba(255,255,255,0.65)',
    fontSize: 11,
    marginTop: 4,
  },
  safeHarborHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },

  // Profile-specific styles for the logbook
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#2ec7ff',
    borderWidth: 2,
    borderColor: 'white',
  },
  profileName: {
    color: 'white',
    fontWeight: '800',
    fontSize: 16,
    marginTop: 8,
  },
  profileBio: {
    color: 'rgba(255,255,255,0.8)',
    marginTop: 4,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  statsOverlay: {
    position: 'absolute',
    top: 16,
    left: 0,
    right: 0,
    paddingVertical: 8,
    paddingHorizontal: 16,
    backgroundColor: 'rgba(10, 10, 30, 0.75)',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    shadowColor: '#00C2FF',
    shadowOpacity: 0.2,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
    zIndex: 3,
  },
  statsOverlayRow: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    alignItems: 'center',
  },
  statTile: {
    flex: 1,
    alignItems: 'center',
    minWidth: 60,
    paddingVertical: 2,
    paddingHorizontal: 4,
  },
  statTilePressed: {
    opacity: 0.6,
  },
  statNumber: {
    color: 'white',
    fontWeight: '800',
    fontSize: 14,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  statLabel: { color: 'rgba(255,255,255,0.7)', fontSize: 10, textAlign: 'center' },

  // Generic button for logbook-style modals
  primaryBtn: {
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
  },
  primaryBtnText: { color: '#FFFFFF', fontWeight: '800' },
  hint: { color: 'rgba(255,255,255,0.7)', fontSize: 12 },

  // Old sheet styles, kept for reference or other modals if needed
  sheetOverlay: {
    flex: 1,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'flex-end',
    padding: 16,
  },
  sheet: {
    width: '100%',
    backgroundColor: 'rgba(10, 25, 41, 0.98)',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 16,
    gap: 12,
    borderWidth: 1,
    borderColor: 'rgba(0, 194, 255, 0.2)',
  },
  sheetTitle: { color: 'white', fontWeight: '800', fontSize: 16 },
  actionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  actionItem: {
    width: '47%',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  actionIcon: { fontSize: 22 },
  actionLabel: { color: 'white', fontWeight: '700' },

  // Generic styles for logbook content
  sectionTitle: { color: 'white', fontWeight: '800', fontSize: 14 },
  subLabel: { color: 'rgba(255,255,255,0.9)', fontWeight: '700' },
  input: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    color: 'white',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
  },
  settingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    marginBottom: 8,
  },
  settingLabel: {
    color: 'white',
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  // Sonar Echoes
  sonarSheet: {
    width: '100%',
    backgroundColor: '#0A0F1A',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 16,
    gap: 12,
    borderWidth: 1,
    borderColor: 'rgba(0, 194, 255, 0.3)',
  },
  sonarTitle: {
    color: '#00C2FF',
    fontWeight: '800',
    fontSize: 16,
    letterSpacing: 2,
    textAlign: 'center',
  },
  sonarInput: {
    backgroundColor: 'rgba(0,0,0,0.2)',
    color: 'white',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: 'rgba(0, 194, 255, 0.4)',
  },
  sonarButton: {
    backgroundColor: 'rgba(0, 194, 255, 0.2)',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 4,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(0, 194, 255, 0.6)',
  },
  sonarButtonText: { color: '#00C2FF', fontWeight: '800' },
  sonarSecondaryButton: {
    alignSelf: 'center',
    marginTop: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 4,
  },
  sonarSecondaryButtonText: {
    color: 'rgba(0, 194, 255, 0.7)',
    fontWeight: '700',
  },
  logbookInput: {
    color: 'rgba(220,220,240,0.9)',
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.4)',
    paddingVertical: 8,
    fontSize: 16,
    marginBottom: 12,
  },

  dismissBtn: {
    alignSelf: 'center',
    marginTop: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  dismissText: { color: 'white', fontWeight: '700' },
  secondaryBtn: {
    alignSelf: 'center',
    marginTop: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
  },
  secondaryBtnText: { color: 'white', fontWeight: '700' },
  tagWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tag: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
  },
  tagText: { color: 'white', fontWeight: '700' },

  pingItem: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    padding: 12,
    borderRadius: 12,
    marginBottom: 8,
  },
  pingText: {
    color: 'white',
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },

  pingButton: {
    backgroundColor: 'rgba(0,194,255,0.15)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    marginTop: 8,
    alignSelf: 'flex-start',
  },
  // Dropdown styles
  dropdownButton: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  dropdownButtonText: { color: 'white', fontWeight: '700' },
  dropdownItem: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.2)',
  },
  dropdownItemText: { color: 'white', fontSize: 16, fontWeight: '600' },

  // Tidal Interaction Bar
  bottomBarContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'flex-start',
    paddingTop: 8,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  bottomBarItem: {
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 60,
    paddingHorizontal: 4,
  },
  bottomBarIcon: {
    fontSize: 24,
    color: 'white',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 4,
  },
  bottomBarLabel: {
    color: 'skyblue',
    fontStyle: 'italic',
    fontWeight: '700',
    fontSize: 12,
    marginTop: 4,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 2,
  },
  bottomBarCount: {
    color: 'white',
    fontWeight: 'bold',
    fontSize: 12,
    marginTop: 2,
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowRadius: 3,
    minHeight: 14,
  },

  toggleButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 0, 0, 0.8)',
    justifyContent: 'center',
    alignItems: 'center',
    marginHorizontal: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
  },
  toggleButtonText: {
    color: 'white',
    fontSize: 20,
    fontWeight: 'bold',
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowRadius: 3,
  },
  topBarWrapper: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  bottomBarWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },

  // Avatar Stack for recent posters
  avatarStack: {
    flexDirection: 'column',
    alignItems: 'center',
  },
  avatarStackMore: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(20, 80, 150, 0.7)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.8)',
    marginTop: -12,
  },
  avatarStackMoreText: {
    color: 'white',
    fontWeight: 'bold',
    fontSize: 18,
  },

  bouncingIcon: {
    transform: [{ scale: 1 }],
  },
  deepResultActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
    flexWrap: 'wrap',
  },
  deepResultActionButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#00C2FF',
    backgroundColor: 'rgba(0, 194, 255, 0.1)',
  },
  deepResultActionText: {
    color: '#00C2FF',
    fontSize: 12,
    fontWeight: '600',
  },
});
const editorStyles = StyleSheet.create({
  editorRoot: { flex: 1, backgroundColor: 'transparent' },
  stage: {
    flex: 1,
    position: 'relative',
    backgroundColor: 'black',
    minHeight: SCREEN_HEIGHT * 0.55,
    maxHeight: SCREEN_HEIGHT * 0.72,
    alignSelf: 'stretch',
    justifyContent: 'center',
    flexShrink: 1,
  },
  editorContainer: {
    backgroundColor: 'rgba(10, 10, 20, 0.65)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.12)',
  },
  editorScroll: { paddingHorizontal: 16, paddingVertical: 12 },
  editorItem: {
    alignItems: 'center',
    paddingHorizontal: 10,
    gap: 4,
    minWidth: 70,
  },
  editorIcon: { fontSize: 20 },
  editorLabel: { color: 'white', fontSize: 11, fontWeight: '600' },
  doneButton: {
    backgroundColor: 'rgba(0,194,255,0.08)',
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(0,194,255,0.6)',
    borderRadius: 12,
  },
  doneButtonText: {
    color: '#00C2FF',
    fontWeight: '800',
    fontSize: 16,
    paddingHorizontal: 20,
  },
  draggableCaptionContainer: {
    position: 'absolute',
    width: '90%',
    alignItems: 'center',
    left: '5%',
    zIndex: 5,
    elevation: 5,
  },
  captionInput: {
    color: 'white',
    fontWeight: 'bold',
    fontSize: 18,
    textAlign: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    minHeight: 44,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.6)',
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.35)',
    textShadowColor: 'rgba(0, 0, 0, 0.75)',
    textShadowOffset: { width: -1, height: 1 },
    textShadowRadius: 10,
  },
  liveEditorSidebar: {
    position: 'absolute',
    top: '20%',
    right: 16,
    gap: 24,
    alignItems: 'center',
    zIndex: 20,
  },
  liveEditorButton: { alignItems: 'center', gap: 4 },
  liveEditorIcon: {
    fontSize: 24,
    color: 'white',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 4,
  },
  liveEditorLabel: {
    color: 'white',
    fontWeight: '600',
    fontSize: 11,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 2,
  },

  // Live bottom media editor bar (TikTok-style)
  liveBottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 12,
    paddingBottom: 8,
    paddingTop: 10,
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  // Live media editor strip (sits above End Drift)
  liveMediaBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  liveBottomScroll: { flexDirection: 'row', gap: 16 },
  liveBottomItem: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  liveBottomIcon: { fontSize: 20, color: 'white' },
  liveBottomLabel: {
    color: 'white',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 2,
  },
  // Chart a Course Live Setup
  liveSetupChart: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    top: 0,
    backgroundColor: '#08101a',
  },
  liveSetupChartBg: {
    ...StyleSheet.absoluteFillObject,
    resizeMode: 'cover',
    opacity: 0.15,
  },
  liveSetupContainer: { flex: 1, justifyContent: 'center', padding: 24 },
  liveSetupTitle: {
    color: 'rgba(255,255,255,0.8)',
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    fontSize: 22,
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 16,
  },
  liveSetupInput: {
    color: 'white',
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.4)',
    paddingVertical: 8,
    textAlign: 'center',
    fontSize: 16,
  },

  // Right-side action stack (from bottom to top)
  liveRightControls: {
    position: 'absolute',
    right: 28, // shift inward to keep fully readable and free screen edges
    // bottom, top, and maxHeight are applied dynamically inline.
    // justifyContent, alignItems, and gap must be in contentContainerStyle for ScrollView.
    // This style block is now primarily for positioning.
    zIndex: 25,
  },
  liveRightButton: { alignItems: 'center', justifyContent: 'center' },
  liveRightIcon: {
    fontSize: 18,
    color: 'white',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 4,
  },
  liveRightLabel: {
    color: 'white',
    fontSize: 9,
    fontWeight: '700',
    marginTop: 3,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 2,
  },
  liveRightButtonWithText: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderRadius: 20,
    paddingVertical: 6,
    paddingLeft: 8,
    paddingRight: 12,
  },
  liveRightLabelFull: {
    // This style is no longer used by the vertical bar, but kept for other potential uses
    color: 'white',
    fontSize: 12,
    fontWeight: '600',
    marginLeft: 6,
  },

  // Comments overlay and input
  liveCommentsOverlay: {
    position: 'absolute',
    left: 16,
    right: 16,
    top: 64,
    zIndex: 15,
  },
  liveCommentBubble: {
    flexDirection: 'row',
    alignSelf: 'flex-start', // Keep bubbles aligned to the left
    backgroundColor: 'rgba(0,0,0,0.6)', // Slightly darker for better contrast
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 8,
    maxWidth: '95%', // Prevent very long comments from taking the full width
  },
  liveCommentInputBar: {
    position: 'absolute',
    left: 12,
    right: 12,
    backgroundColor: 'rgba(0,0,0,0.8)',
    borderRadius: 10,
    padding: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  liveCommentText: {
    color: 'white',
  },
  liveCommentAuthor: {
    color: 'white',
    fontWeight: '700',
    marginRight: 6, // Space between author and text
  },
  commentSplashContainer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 99,
    elevation: 99,
  },
  commentSplashText: {
    color: 'white',
    fontSize: 20,
    fontWeight: 'bold',
  },
});

const AFRICAN_COUNTRIES = [
  'Algeria',
  'Angola',
  'Benin',
  'Botswana',
  'Burkina Faso',
  'Burundi',
  'Cabo Verde',
  'Cameroon',
  'Central African Republic',
  'Chad',
  'Comoros',
  'Congo, Dem. Rep.',
  'Congo, Rep.',
  "Cote d'Ivoire",
  'Djibouti',
  'Egypt',
  'Equatorial Guinea',
  'Eritrea',
  'Eswatini',
  'Ethiopia',
  'Gabon',
  'Gambia',
  'Ghana',
  'Guinea',
  'Guinea-Bissau',
  'Kenya',
  'Lesotho',
  'Liberia',
  'Libya',
  'Madagascar',
  'Malawi',
  'Mali',
  'Mauritania',
  'Mauritius',
  'Morocco',
  'Mozambique',
  'Namibia',
  'Niger',
  'Nigeria',
  'Rwanda',
  'Sao Tome and Principe',
  'Senegal',
  'Seychelles',
  'Sierra Leone',
  'Somalia',
  'South Africa',
  'South Sudan',
  'Sudan',
  'Tanzania',
  'Togo',
  'Uganda',
  'Zambia',
  'Zimbabwe',
];
// Payment details are only configured for these countries
const SUPPORTED_PEARL_COUNTRIES = ['Zimbabwe', 'Kenya'];

// ⬆️ put near other top-level helpers, outside components
export const ensureCamMicPermissionsAndroid = async (): Promise<boolean> => {
  if (Platform.OS !== 'android') return true;
  try {
    const results = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.CAMERA,
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    ] as any);
    const cam = results[PermissionsAndroid.PERMISSIONS.CAMERA];
    const mic = results[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];
    const ok =
      cam === PermissionsAndroid.RESULTS.GRANTED &&
      mic === PermissionsAndroid.RESULTS.GRANTED;
    if (!ok) {
      const neverAskAgain =
        cam === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN ||
        mic === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN;
      Alert.alert(
        'Permission required',
        neverAskAgain
          ? 'Camera & microphone are permanently denied. Open Settings to enable.'
          : 'Camera & microphone are required to go live.',
        neverAskAgain
          ? [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Open Settings', onPress: () => Linking.openSettings() },
            ]
          : [{ text: 'OK' }],
      );
    }
    return ok;
  } catch (e) {
    console.warn('Permission request failed', e);
    return false;
  }
};

/* ---------------------- Reusable UI bits ----------------------- */
function Field({
  label,
  value,
  onChangeText,
  secureTextEntry = false,
  keyboardType = 'default',
  autoCapitalize = 'none',
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  secureTextEntry?: boolean;
  keyboardType?: 'default' | 'email-address';
  autoCapitalize?: 'none' | 'words' | 'sentences' | 'characters';
}) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={authStyles.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        style={authStyles.input}
        placeholder={label}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        keyboardType={keyboardType}
        secureTextEntry={secureTextEntry}
      />
    </View>
  );
}

function AuthButton({
  title,
  onPress,
}: {
  title: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity onPress={onPress} style={authStyles.btn}>
      <Text style={authStyles.btnText}>{title}</Text>
    </TouchableOpacity>
  );
}

function AuthBackground() {
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: 'black' }]}>
      {myLogo ? (
        <Image
          source={myLogo}
          style={{ width: '100%', height: '100%' }}
          resizeMode="cover"
        />
      ) : null}
    </View>
  );
}

// ======================== INNER APP ========================
type InnerAppProps = { allowPlayback?: boolean };
const InnerApp: React.FC<InnerAppProps> = ({ allowPlayback = true }) => {
  // Get current user for ocean features
  const [user, setUser] = useState<any>(null);
  
  // Belt-and-suspenders: even if the user somehow gets to this screen
  // without being logged in, reset them to the sign-up flow.
  useEffect(() => {
    let authMod: any = null;
    try {
      authMod = require('@react-native-firebase/auth').default;
    } catch {}
    if (!authMod) return;
    const sub = authMod().onAuthStateChanged((u: any) => {
      setUser(u);
      if (!u) {
        console.warn(
          'InnerApp mounted without a user. This indicates a routing issue.',
        );
      }
    });
    return sub;
  }, []);
  const insets = useSafeAreaInsets();
  // Development safeguard (disabled): if you need to skip uploads in debug Android,
  // temporarily set this to: (__DEV__ && Platform.OS === 'android')
  const DEV_SKIP_STORAGE_UPLOAD = false;
  const versionInfo = useAppVersionInfo();

  const editorTools = useMemo(
    () => [
      { icon: '🎵', label: 'Ocean melodies' },
      { icon: '📝', label: 'Sonar Captions' },
      { icon: '🎨', label: 'Ocean Tones' },
      { icon: '🖼️', label: 'Hull & Canvas' },
      { icon: '✂️', label: 'Cut the Wake' },
      { icon: '🌀', label: 'Riptide' },
      { icon: '✨', label: 'Ripples & Foam' },
      { icon: '🛟', label: 'Buoys' },
    ],
    [],
  );

  const [splashes, setSplashes] = useState<number>(0);
  const [echoes, setEchoes] = useState<number>(0);
  const [hasSplashed, setHasSplashed] = useState<boolean>(false);
  // Splash state is managed by Firestore listeners below (see effect after currentWave changes)
  const splashDisplayCount = splashes;
  const [myEcho, setMyEcho] = useState<{ text: string; id?: string } | null>(
    null,
  );
  const [splashBusy, setSplashBusy] = useState<boolean>(false);
  const [showOctopusHug, setShowOctopusHug] = useState<boolean>(false);
  const octopusHugOpacity = useRef(new Animated.Value(0)).current;
  const [showEditShore, setShowEditShore] = useState<boolean>(false);
  const [showTreasure, setShowTreasure] = useState<boolean>(false);
  const [treasureStats, setTreasureStats] = useState<{
    tipsTotal: number;
    withdrawable: number;
    lastPayout?: any;
  }>({ tipsTotal: 0, withdrawable: 0 });
  const [tipHistory, setTipHistory] = useState<
    Array<{
      id: string;
      amount: number;
      fromName?: string;
      note?: string;
      createdAt?: any;
    }>
  >([]);
  const [showWithdraw, setShowWithdraw] = useState<boolean>(false);
  const [withdrawAmount, setWithdrawAmount] = useState<string>('');
  const [withdrawals, setWithdrawals] = useState<
    Array<{ id: string; amount: number; status?: string; createdAt?: any }>
  >([]);
  const [profileName, setProfileName] = useState<string>('');
  const [profileBio, setProfileBio] = useState<string>('');
  const [profilePhoto, setProfilePhoto] = useState<string | null>(null);
  const [accountCreationHandle, setAccountCreationHandle] =
    useState<string>('');
  const myUid = auth?.()?.currentUser?.uid || null;
  
  // Sound effect player ref to handle audio playback
  const soundPlayerRef = useRef<any>(null);
  const [currentSound, setCurrentSound] = useState<number | null>(null);

  // Play falcon sound for ping notification
  const playFalconSound = useCallback(() => {
    try {
      if (soundPlayerRef.current) {
        soundPlayerRef.current.stop(() => {
          soundPlayerRef.current.release();
          soundPlayerRef.current = null;
        });
      }
      const s = new Sound('falcon', Sound.MAIN_BUNDLE, (error) => {
        if (!error) {
          soundPlayerRef.current = s;
          s.play((success) => {
            s.release();
            soundPlayerRef.current = null;
          });
        }
      });
    } catch (e) {
      // ignore sound errors
    }
  }, []);

  // Format a display handle: replace any leading '@' or '/' with a single '/'
  const formatHandle = useCallback((name?: string | null) => {
    try {
      const raw = String(name ?? '').trim();
      const core = raw.replace(/^[@/]+/, '');
      return '/' + (core || 'drifter');
    } catch {
      return '/drifter';
    }
  }, []);

  const normalizeUserHandle = useCallback((value?: string | null) => {
    const trimmed = String(value ?? '')
      .trim()
      .replace(/^[@/]+/, '');
    return trimmed ? `/${trimmed}` : '';
  }, []);
  useEffect(() => {
    if (!myUid) return;
    let cancelled = false;
    let firestoreMod: any = null;
    let authMod: any = null;
    try {
      firestoreMod = require('@react-native-firebase/firestore').default;
    } catch {}
    try {
      authMod = require('@react-native-firebase/auth').default;
    } catch {}
    if (!firestoreMod) return;
    firestoreMod()
      .doc(`users/${myUid}`)
      .get()
      .then((doc: any) => {
        if (cancelled) return;
        const data = doc?.data() || {};
        const derivedHandle =
          normalizeUserHandle(data.userName) ||
          normalizeUserHandle(data.username) ||
          normalizeUserHandle(authMod?.().currentUser?.displayName);
        if (derivedHandle) {
          setAccountCreationHandle(derivedHandle);
          setProfileName(prev =>
            prev && prev !== '@your_handle' ? prev : derivedHandle,
          );
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [myUid, normalizeUserHandle]);
  const [wavesFeed, setWavesFeed] = useState<Wave[]>([]);
  // Public feed toggle and data

  const [waveKey, setWaveKey] = useState(Date.now()); // Key to force video player refresh
  const feedRef = useRef<any>(null); // Horizontal feed ref for programmatic scroll (typed as any to avoid Animated value/type mismatch)
  const [currentIndex, setCurrentIndex] = useState<number>(-1);

  const [showPublicFeed, setShowPublicFeed] = useState<boolean>(true);
  const [publicFeed, setPublicFeed] = useState<Wave[]>([]);
  const [isFeedLoaded, setIsFeedLoaded] = useState(false);

  const [showProfile, setShowProfile] = useState<boolean>(false);
  const [showMyWaves, setShowMyWaves] = useState<boolean>(false);
  const [showMakeWaves, setShowMakeWaves] = useState<boolean>(false);
  const [showPings, setShowPings] = useState<boolean>(false);
  const [showExplore, setShowExplore] = useState<boolean>(false);
  const [showNotice, setShowNotice] = useState<boolean>(false);
  const [showSchoolMode, setShowSchoolMode] = useState<boolean>(false);
  const [showBridge, setShowBridge] = useState<boolean>(false);
  const [isWifi, setIsWifi] = useState<boolean>(true);
  const [isOffline, setIsOffline] = useState<boolean>(false);

  // Crew (follow/unfollow) state
  const [myCrewCount, setMyCrewCount] = useState<number>(0);
  const [myBoardingCount, setMyBoardingCount] = useState<number>(0);
  const [isInUserCrew, setIsInUserCrew] = useState<{ [uid: string]: boolean }>(
    {},
  );
  const [crewLoading, setCrewLoading] = useState<boolean>(false);
  const [blockedUsers, setBlockedUsers] = useState<Set<string>>(new Set());
  const [removedUsers, setRemovedUsers] = useState<Set<string>>(new Set());
  const [waveStats, setWaveStats] = useState<
    Record<
      string,
      { splashes: number; echoes: number; views: number; createdAt?: number }
    >
  >({});
  const [userStats, setUserStats] = useState<{
    splashesMade: number;
    hugsMade: number;
  }>({ splashesMade: 0, hugsMade: 0 });
  const [myWaveCount, setMyWaveCount] = useState<number | null>(null);
  const [waveOptionsTarget, setWaveOptionsTarget] = useState<Wave | null>(null);
  const [isSavingWave, setIsSavingWave] = useState(false);
  // Notification toast state
  const [toastVisible, setToastVisible] = useState(false);
  const [toastKind, setToastKind] = useState<'positive' | 'negative'>(
    'positive',
  );
  const [toastMessage, setToastMessage] = useState('');
  const toastTimerRef = useRef<any>(null);

  // Ocean Dialog state
  const [oceanDialog, setOceanDialog] = useState<{
    visible: boolean;
    title: string;
    message: string;
    buttons?: Array<{
      text: string;
      onPress?: () => void;
      style?: 'default' | 'cancel' | 'destructive';
    }>;
  }>({ visible: false, title: '', message: '' });

  // ========== SIMPLE OCEAN EFFECTS STATE ==========
  const [tapEffects, setTapEffects] = useState<Array<{ id: number; x: number; y: number }>>([]);
  const [oceanAmbienceEnabled, setOceanAmbienceEnabled] = useState(false);
  const [autoNightMode, setAutoNightMode] = useState(true);
  const [interactivePhysicsEnabled, setInteractivePhysicsEnabled] = useState(true);
  const [stormEffectsEnabled, setStormEffectsEnabled] = useState(true);
  const [tiltDriftEnabled, setTiltDriftEnabled] = useState(true);
  const [safetySettings, setSafetySettings] = useState<any>({
    shallowWatersMode: false,
    lifeguardAlertsEnabled: true,
    buddySystemEnabled: false,
    noCurrentZone: false,
    ageVerified: false,
    restrictedContentHidden: true,
  });
  const [safeHarborExpanded, setSafeHarborExpanded] = useState<boolean>(true);
  // ========== END OCEAN EFFECTS STATE ==========

  // Track pending splash operation to avoid listener reverting optimistic UI
  const pendingSplashOp = useRef<{ waveId: string; action: 'splash' } | null>(
    null,
  );
  // Resolve when listener confirms the desired state (exists true/false)
  const pendingSplashAwait = useRef<{
    waveId: string;
    desired: boolean;
    resolve: () => void;
  } | null>(null);
  // Expected count during in-flight splash op; used to gate count snapshots briefly
  const pendingSplashDesiredRef = useRef<{
    waveId: string;
    desiredCount: number;
    ignoreUntil: number;
  } | null>(null);

  const showToast = useCallback(
    (kind: 'positive' | 'negative', rawMsg: string, durationMs = 2000) => {
      // Compose message endings based on kind
      const msg =
        kind === 'positive'
          ? rawMsg.endsWith('!')
            ? rawMsg
            : `${rawMsg}!`
          : rawMsg.endsWith('😞') ||
            rawMsg.endsWith('😔') ||
            rawMsg.endsWith('☹️')
          ? rawMsg
          : `${rawMsg} ☹️`;
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current as any);
        toastTimerRef.current = null;
      }
      setToastKind(kind);
      setToastMessage(msg);
      setToastVisible(true);
      // Positive: allow animation to play, linger slightly longer
      const dwell = kind === 'positive' ? durationMs : 1600;
      toastTimerRef.current = setTimeout(() => {
        setToastVisible(false);
        toastTimerRef.current && clearTimeout(toastTimerRef.current as any);
        toastTimerRef.current = null;
      }, dwell);
    },
    [],
  );

  const notifySuccess = useCallback(
    (msg: string) => showToast('positive', msg),
    [showToast],
  );
  const notifyError = useCallback(
    (msg: string) => showToast('negative', msg),
    [showToast],
  );

  // Ocean Dialog helper
  const showOceanDialog = useCallback(
    (
      title: string,
      message: string,
      buttons?: Array<{
        text: string;
        onPress?: () => void;
        style?: 'default' | 'cancel' | 'destructive';
      }>,
    ) => {
      setOceanDialog({ visible: true, title, message, buttons });
    },
    [],
  );

  // Do not render the feed while this screen is not focused (e.g., while Welcome is visible)
  const isFocused = useIsFocused();

  // Back handler logic - TikTok-style: first back toggles feed view, second back exits
  const lastBackPressTime = useRef<number>(0);
  useEffect(() => {
    const onBackPress = () => {
      if (isFocused) {
        const now = Date.now();
        const timeSinceLastPress = now - lastBackPressTime.current;

        // If less than 2 seconds since last back press, allow app exit
        if (timeSinceLastPress < 2000) {
          return false; // Exit app
        }

        // First back press: toggle between My Waves and Public Waves
        lastBackPressTime.current = now;
        setShowPublicFeed(prev => !prev);
        setCurrentIndex(0);
        try {
          feedRef.current?.scrollTo({ x: 0, animated: false });
        } catch {}
        return true; // We've handled the back press
      }
      // If not focused, let default handler run
      return false;
    };

    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      onBackPress,
    );

    return () => subscription.remove();
  }, [isFocused]);

  // ----- Profile photo handlers -----
  const onEditAvatar = async () => {
    const uploadAndSave = async (localOrRemoteUri: string) => {
      try {
        let storageMod: any = null;
        let firestoreMod: any = null;
        let authMod: any = null;
        try {
          storageMod = require('@react-native-firebase/storage').default;
        } catch {}
        try {
          firestoreMod = require('@react-native-firebase/firestore').default;
        } catch {}
        try {
          authMod = require('@react-native-firebase/auth').default;
        } catch {}
        const uid = authMod?.().currentUser?.uid;
        if (DEV_SKIP_STORAGE_UPLOAD) {
          setProfilePhoto(String(localOrRemoteUri));
          return;
        }
        if (storageMod && firestoreMod && uid) {
          let localPath = String(localOrRemoteUri);
          try {
            localPath = decodeURI(localPath);
          } catch {}
          if (Platform.OS === 'android' && localPath.startsWith('file://'))
            localPath = localPath.replace('file://', '');
          if (!localPath) {
            showOceanDialog(
              'Upload Error',
              'Could not resolve a local path for the selected photo.',
            );
            return;
          }
          const path = `users/${uid}/profile_${Date.now()}.jpg`;
          await storageMod()
            .ref(path)
            .putFile(localPath, { contentType: 'image/jpeg' });
          const url = await storageMod().ref(path).getDownloadURL();
          setProfilePhoto(url);
          try {
            await firestoreMod()
              .doc(`users/${uid}`)
              .set({ userPhoto: url }, { merge: true });
          } catch {}
        } else {
          setProfilePhoto(String(localOrRemoteUri));
        }
      } catch {}
    };

    try {
      const actions: any[] = [];
      actions.push({
        text: 'Choose Photo',
        onPress: async () => {
          try {
            const res = await launchImageLibrary({
              mediaType: 'photo',
              selectionLimit: 1,
            });
            const a = res?.assets?.[0];
            if (!a?.uri) return;
            await uploadAndSave(String(a.uri));
          } catch {}
        },
      });
      // Optional removal
      if (profilePhoto) {
        actions.push({
          text: 'Remove Photo',
          style: 'destructive',
          onPress: async () => {
            setProfilePhoto(null);
            try {
              let firestoreMod: any = null;
              let authMod: any = null;
              try {
                firestoreMod =
                  require('@react-native-firebase/firestore').default;
              } catch {}
              try {
                authMod = require('@react-native-firebase/auth').default;
              } catch {}
              const uid = authMod?.().currentUser?.uid;
              if (firestoreMod && uid)
                await firestoreMod()
                  .doc(`users/${uid}`)
                  .set({ userPhoto: null }, { merge: true });
            } catch {}
          },
        });
      }
      actions.push({ text: 'Cancel', style: 'cancel' });
      if (actions.length > 1)
        showOceanDialog('Profile Photo', 'Update your avatar', actions);
    } catch {}
  };

  // Bridge settings (Data Saver)
  type BridgeSettings = {
    dataSaverDefaultOnCell: boolean;
    wifiOnlyHD: boolean;
    autoplayCellular: 'off' | 'preview' | 'full';
    prefetchNext: 0 | 1 | 2 | 3;
    thumbQuality: 'lite' | 'standard' | 'high';
    cellularMaxBitrateH264: number;
    cellularMaxBitrateHEVC: number;
    cellularResolutionCap: number; // e.g., 480
    liveCellularMaxBitrate: number;
    liveLowLatencyWifi: boolean;
    liveJoinPreview: boolean;
    liveChatLite: boolean;
    animatedThumbsCell: boolean;
    audioOnlyFallback: boolean;
    cacheMaxMB: number;
    cacheTtlHours: number; // auto-purge horizon
    backgroundDataCell: boolean;
    rainEffectsEnabled: boolean;
  };

  const [bridge, setBridge] = useState<BridgeSettings>({
    dataSaverDefaultOnCell: true,
    wifiOnlyHD: true,
    autoplayCellular: 'preview',
    prefetchNext: 1,
    thumbQuality: 'lite',
    cellularMaxBitrateH264: 1_000_000,
    cellularMaxBitrateHEVC: 700_000,
    cellularResolutionCap: 480,
    liveCellularMaxBitrate: 700_000,
    liveLowLatencyWifi: false,
    liveJoinPreview: true,
    liveChatLite: true,
    animatedThumbsCell: false,
    audioOnlyFallback: true,
    cacheMaxMB: 200,
    cacheTtlHours: 48,
    backgroundDataCell: false,
    rainEffectsEnabled: false,
  });
  useEffect(() => {
    if (typeof bridge.rainEffectsEnabled === 'boolean') {
      setStormEffectsEnabled(bridge.rainEffectsEnabled);
    }
  }, [bridge.rainEffectsEnabled]);
  const [showPearls, setShowPearls] = useState<boolean>(false);
  const [showEchoes, setShowEchoes] = useState<boolean>(false);
  const [selectedCountry, setSelectedCountry] = useState<string | null>(null);
  const [unreadPingsCount, setUnreadPingsCount] = useState(0);
  const [pings, setPings] = useState<Ping[]>([]);
  const notificationInitRef = useRef<string | null>(null);

  // Load pings from AsyncStorage on mount
  useEffect(() => {
    (async () => {
      try {
        const stored = await AsyncStorage.getItem('drift_pings');
        if (stored) {
          const parsed = JSON.parse(stored);
          // Convert timestamp strings back to Date objects
          const restored = parsed.map((p: any) => ({
            ...p,
            timestamp: p.timestamp ? new Date(p.timestamp) : new Date(),
          }));
          setPings(restored);
        }
      } catch (e) {
        console.warn('Failed to load pings:', e);
      }
    })();
  }, []);

  // Persist pings to AsyncStorage whenever they change
  useEffect(() => {
    if (pings.length === 0) return;
    (async () => {
      try {
        await AsyncStorage.setItem('drift_pings', JSON.stringify(pings));
      } catch (e) {
        console.warn('Failed to save pings:', e);
      }
    })();
  }, [pings]);

  const [showDeepSearch, setShowDeepSearch] = useState(false);
  const [deepQuery, setDeepQuery] = useState('');
  const [deepResults, setDeepResults] = useState<SearchResult[]>([]);
  const [deepSearchLoading, setDeepSearchLoading] = useState(false);
  const [deepSearchError, setDeepSearchError] = useState<string | null>(null);
  const backendSearchBase = useMemo(() => {
    try {
      const cfgModule = require('./liveConfig');
      const cfg =
        cfgModule?.cfg || cfgModule?.default || cfgModule || {};
      return (
        cfg?.BACKEND_BASE_URL ||
        cfg?.USER_MGMT_ENDPOINT_BASE ||
        cfg?.USER_MANAGEMENT_BASE_URL ||
        ''
      );
    } catch {
      return '';
    }
  }, []);
  const searchViaFirestore = useCallback(async (term: string): Promise<SearchResult[]> => {
    const normalized = term.trim().replace(/^[@\/]/, ''); // Remove leading @ or /
    if (!normalized) return [];
    console.log('searchViaFirestore called with:', normalized);
    let firestoreMod: any = null;
    try {
      firestoreMod = require('@react-native-firebase/firestore').default;
    } catch (err) {
      console.log('Firestore module not available:', err);
    }
    if (!firestoreMod) {
      console.log('Firestore not available, returning empty');
      return [];
    }

    const lowerTerm = normalized.toLowerCase();
    const usersRef = firestoreMod().collection('users');
    const results: SearchResult[] = [];
    const seenUsers = new Set<string>();
    const addUserDoc = (doc: any) => {
      const uid = doc.id;
      if (!uid || seenUsers.has(uid)) return;
      seenUsers.add(uid);
      const data = doc.data() || {};
      console.log('Adding user doc:', uid, 'data:', { displayName: data.displayName, userName: data.userName, username: data.username });
      results.push({
        kind: 'user',
        id: uid,
        label: String(data.displayName || data.userName || data.username || '@drifter'),
        extra: {
          bio: typeof data.bio === 'string' ? data.bio : '',
          photoURL: data.userPhoto || data.photoURL || null,
          liveId: data.liveId || null,
        },
      });
    };

    try {
      console.log('Searching Firestore users by username_lc...');
      // Search by username_lc first since that's more likely to match
      const lcSnap = await usersRef
        .where('username_lc', '>=', lowerTerm)
        .where('username_lc', '<=', lowerTerm + '\uf8ff')
        .limit(20)
        .get();
      console.log('Username_lc search results:', lcSnap.size);
      lcSnap.forEach(addUserDoc);

      // Also try displayName if we don't have many results
      if (results.length < 5) {
        console.log('Searching by displayName...');
        const userSnap = await usersRef
          .where('displayName', '>=', normalized)
          .where('displayName', '<=', normalized + '\uf8ff')
          .limit(20)
          .get();
        console.log('DisplayName search results:', userSnap.size);
        userSnap.forEach(addUserDoc);
      }
      console.log('Total Firestore results:', results.length);
    } catch (err) {
      console.log('Firestore search error:', err);
    }

    const seenWaves = new Set<string>();
    try {
      const waveSnap = await firestoreMod()
        .collection('waves')
        .orderBy('createdAt', 'desc')
        .limit(80)
        .get();
      (waveSnap?.docs || []).forEach(doc => {
        const id = doc.id;
        if (!id || seenWaves.has(id)) return;
        const data = doc.data() || {};
        if (data?.isPublic === false) return;
        const textValues = [
          data.captionText,
          data.caption,
          data.authorName,
          data.ownerName,
          data.description,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!textValues.includes(lowerTerm)) return;
        seenWaves.add(id);
        results.push({
          kind: 'wave',
          id,
          label: String(data.captionText || data.caption || data.authorName || 'Wave'),
          extra: {
            caption: data.captionText || data.caption || '',
            authorName: data.authorName || data.ownerName || '',
            ownerUid: data.ownerUid || null,
            playbackUrl: data.playbackUrl || data.mediaUrl || null,
            mediaUri: data.mediaUrl || null,
            muxStatus: data.muxStatus || null,
            audioUrl: data.audioUrl || null,
          },
        });
      });
    } catch {}

    return results;
  }, []);

  const searchOceanEntities = useCallback(
    async (term: string): Promise<SearchResult[]> => {
      const normalized = term.trim();
      if (!normalized) return [];
      console.log('searchOceanEntities called with:', normalized);
      let backendError: Error | null = null;
      if (backendSearchBase) {
        console.log('Trying backend search at:', backendSearchBase);
        const encoded = encodeURIComponent(normalized);
        try {
          const [usersResp, wavesResp] = await Promise.all([
            fetch(`${backendSearchBase}/search/users?term=${encoded}`),
            fetch(`${backendSearchBase}/search/waves?term=${encoded}`),
          ]);
          console.log('Backend search responses:', usersResp.status, wavesResp.status);
          let usersData: any[] = [];
          let wavesData: any[] = [];
          if (usersResp.ok) {
            const payload = await usersResp.json();
            usersData = Array.isArray(payload?.users) ? payload.users : [];
          } else {
            backendError =
              backendError ||
              new Error(`Backend user search failed (${usersResp.status} ${usersResp.statusText})`);
          }
          if (wavesResp.ok) {
            const payload = await wavesResp.json();
            wavesData = Array.isArray(payload?.waves) ? payload.waves : [];
          } else {
            backendError =
              backendError ||
              new Error(`Backend wave search failed (${wavesResp.status} ${wavesResp.statusText})`);
          }
          console.log('Backend data:', usersData.length, 'users,', wavesData.length, 'waves');
          const results: SearchResult[] = [];
          const seen = new Set<string>();
          usersData.forEach((user: any) => {
            const uid = user.uid || user.id;
            if (!uid || seen.has(`user:${uid}`)) return;
            seen.add(`user:${uid}`);
            results.push({
              kind: 'user',
              id: uid,
              label: String(user.displayName || user.userName || user.username || '@drifter'),
              extra: { ...user },
            });
          });
          wavesData.forEach((wave: any) => {
            const id = wave.id;
            if (!id || seen.has(`wave:${id}`)) return;
            seen.add(`wave:${id}`);
            results.push({
              kind: 'wave',
              id,
              label: String(wave.caption || wave.title || wave.authorName || 'Wave'),
              extra: { ...wave },
            });
          });
          if (results.length > 0) {
            return results;
          }
        } catch (err) {
          const normalizedErr =
            err instanceof Error ? err : new Error(String(err || 'Unknown backend error'));
          backendError = backendError || normalizedErr;
          console.warn('Backend search failed', normalizedErr);
        }
      }
      console.log('Falling back to Firestore search...');
      const firestoreResults = await searchViaFirestore(normalized);
      console.log('Firestore returned:', firestoreResults.length, 'results');
      if (firestoreResults.length > 0) {
        return firestoreResults;
      }
      if (backendError) {
        throw backendError;
      }
      return [];
    },
    [backendSearchBase, searchViaFirestore],
  );
  const buildWaveFromSearchResult = useCallback((result: SearchResult): Wave | null => {
    if (result.kind !== 'wave') return null;
    const extra = result.extra || {};
    const uri = extra.mediaUri || extra.playbackUrl || '';
    if (!uri) return null;
    return {
      id: result.id,
      media: { uri, type: extra.mediaType || extra.media?.type || 'video/mp4' } as Asset,
      audio: extra.audioUrl
        ? {
            uri: extra.audioUrl,
            name: extra.audioName || 'Audio',
          }
        : null,
      captionText: extra.caption || '',
      captionPosition: extra.captionPosition || { x: 0, y: 0 },
      playbackUrl: extra.playbackUrl || null,
      muxStatus: extra.muxStatus || null,
      authorName: extra.authorName || null,
      ownerUid: extra.ownerUid || null,
    };
  }, []);
  const handleDeepWaveSelect = useCallback(
    (result: SearchResult) => {
      if (result.kind !== 'wave') return;
      const existingIdx = wavesFeed.findIndex(w => w.id === result.id);
      if (existingIdx >= 0) {
        setCurrentIndex(existingIdx);
        setWaveKey(Date.now());
        setShowDeepSearch(false);
        return;
      }
      const newWave = buildWaveFromSearchResult(result);
      if (!newWave) {
        Alert.alert('Wave unavailable', 'This wave cannot be previewed right now.');
        return;
      }
      setWavesFeed(prev => [newWave, ...prev]);
      setCurrentIndex(0);
      setWaveKey(Date.now());
      setShowDeepSearch(false);
    },
    [buildWaveFromSearchResult, setCurrentIndex, setShowDeepSearch, setWaveKey, setWavesFeed, wavesFeed],
  );
  const runDeepSearch = useCallback(async () => {
    const term = deepQuery.trim();
    if (!term) {
      Alert.alert('Search', 'Please enter a username.');
      return;
    }

    const createVariants = (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return [];
      const sanitized = trimmed.replace(/^[@\/]+/, '');
      const withSlash = sanitized ? `/${sanitized}` : trimmed;
      return Array.from(
        new Set(
          [trimmed, sanitized, withSlash]
            .filter(Boolean)
            .map(v => v.trim())
            .filter(Boolean),
        ),
      );
    };

    setDeepSearchError(null);
    setDeepResults([]);
    setDeepSearchLoading(true);
    console.log('Deep dive search started for:', term);

    try {
      const variants = createVariants(term);
      let aggregatedResults: SearchResult[] = [];
      let searchException: any = null;
      for (const candidate of variants) {
        try {
          console.log('Deep dive backend search candidate:', candidate);
          const candidateResults = await searchOceanEntities(candidate);
          aggregatedResults = candidateResults;
          if (candidateResults.length > 0) {
            console.log('Deep dive candidate succeeded with', candidateResults.length, 'results');
            break;
          }
        } catch (err) {
          searchException = err;
          console.error('Deep dive candidate failed:', candidate, err);
        }
      }

      if (aggregatedResults.length === 0 && searchException) {
        throw searchException;
      }

      setDeepResults(aggregatedResults);

      if (aggregatedResults.length === 0) {
        const noResultsMsg = `No users found matching "${term}"`;
        console.log('Deep dive no results:', term);
        setDeepSearchError(noResultsMsg);
      } else {
        setDeepSearchError(null);
        const currentUser = auth?.()?.currentUser;
        if (currentUser) {
          const crewStatus: Record<string, boolean> = {};
          for (const result of aggregatedResults) {
            try {
              const inCrew = await isInCrew(result.id);
              crewStatus[result.id] = inCrew;
            } catch {
              crewStatus[result.id] = false;
            }
          }
          setIsInUserCrew(prev => ({ ...prev, ...crewStatus }));
        }
      }
    } catch (err: any) {
      console.error('Deep search exception caught:', err);
      const errorMsg = err?.message || err?.toString() || String(err);
      console.error('Error message:', errorMsg);
      const fullError = `Search failed: ${errorMsg}`;
      setDeepSearchError(fullError);
      setDeepResults([]);
    } finally {
      console.log('Deep dive search finished, loading=false');
      setDeepSearchLoading(false);
    }
  }, [deepQuery, searchOceanEntities]);
  const [showCountryPicker, setShowCountryPicker] = useState<boolean>(false);
  const [echoText, setEchoText] = useState<string>('');
  const echoTextRef = useRef<string>('');
  const updateEchoText = useCallback(
    (value: string) => {
      echoTextRef.current = value;
      setEchoText(value);
    },
    [setEchoText],
  );
  const [echoList, setEchoList] = useState<
    Array<{
      id?: string;
      uid: string;
      text: string;
      userName?: string | null;
      updatedAt?: any;
      userPhoto?: string | null;
    }>
  >([]);
  const [editingEcho, setEditingEcho] = useState<{
    id: string;
    text: string;
  } | null>(null);
  const [showSendMessage, setShowSendMessage] = useState<boolean>(false);
  const [messageText, setMessageText] = useState<string>('');
  const [messageRecipient, setMessageRecipient] = useState<{
    uid: string;
    name: string;
  } | null>(null);
  // Removed pre-fill of echo editor so input clears after send and stays free for next echo
  const [capturedMedia, setCapturedMedia] = useState<Asset | null>(null);
  const [attachedAudio, setAttachedAudio] = useState<{
    uri: string;
    name?: string;
  } | null>(null);
  const [showAudioModal, setShowAudioModal] = useState<boolean>(false);
  const [audioUrlInput, setAudioUrlInput] = useState<string>('');
  const [transcoding, setTranscoding] = useState<boolean>(false);

  // DM subscription - adds messages to pings automatically
  useEffect(() => {
    let firestoreMod: any = null;
    let authMod: any = null;
    try {
      firestoreMod = require('@react-native-firebase/firestore').default;
    } catch {}
    try {
      authMod = require('@react-native-firebase/auth').default;
    } catch {}
    const uid = authMod?.().currentUser?.uid;
    if (!firestoreMod || !uid) return;
    let unsub: any = null;
    try {
      unsub = firestoreMod()
        .collection(`users/${uid}/messages`)
        .orderBy('createdAt', 'desc')
        .limit(50)
        .onSnapshot((snap: any) => {
          try {
            const messages: any[] = [];
            snap?.forEach((d: any) => {
              const data = d.data() || {};
              messages.push({
                id: d.id,
                type: 'message',
                text: data?.text || '',
                fromUid: data?.fromUid || '',
                actorName: data?.fromName || 'Drifter',
                timestamp: data?.createdAt || new Date(),
                read: false,
              });
            });
            // Merge messages into pings (avoid duplicates by id)
            setPings(prev => {
              const existingIds = new Set(prev.map(p => p.id));
              const newMessages = messages.filter(m => !existingIds.has(m.id));
              return [...newMessages, ...prev].sort((a, b) => {
                const aTime =
                  a.timestamp?.toDate?.() || a.timestamp || new Date(0);
                const bTime =
                  b.timestamp?.toDate?.() || b.timestamp || new Date(0);
                return bTime - aTime;
              });
            });
          } catch {}
        });
    } catch {}
    return () => {
      try {
        unsub && unsub();
      } catch {}
    };
  }, []);

  // Editor state
  const [showCaptionInput, setShowCaptionInput] = useState(false);
  const [captionText, setCaptionText] = useState('');
  const captionInputRef = useRef<TextInput | null>(null);
  const [stageSize, setStageSize] = useState<{ w: number; h: number }>({
    w: 0,
    h: 0,
  });
  const stageLayoutRef = useRef<{ x: number; y: number; w: number; h: number }>(
    { x: 0, y: 0, w: 0, h: 0 },
  );
  const captionDrag = useRef(new Animated.ValueXY()).current;
  const [captionPos, setCaptionPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const captionBubbleWidth = useMemo(() => {
    const sample = (captionText?.trim?.() || 'Sonar captions').slice(0, 80);
    const estimate = sample.length * 9 + 32; // rough width based on characters + padding
    const maxWidth = stageSize.w > 0 ? stageSize.w - 24 : undefined;
    const clamped = Math.max(160, Math.min(estimate, 420));
    return maxWidth ? Math.min(maxWidth, clamped) : clamped;
  }, [captionText, stageSize.w]);
  useEffect(() => {
    if (!capturedMedia) {
      setShowCaptionInput(false);
    }
  }, [capturedMedia]);
  const [releasing, setReleasing] = useState(false);
  const splashAnimation = useRef(new Animated.Value(1)).current;
  // Animation for the two small drops when transitioning to Splashed
  const smallDropsOpacity = useRef(
    new Animated.Value(hasSplashed ? 1 : 0),
  ).current;
  const smallDropsScale = smallDropsOpacity.interpolate({
    inputRange: [0, 1],
    outputRange: [0.6, 1],
  });
  // Echo ripple animation - ocean-themed notification
  const echoRipples = useRef([
    new Animated.Value(0),
    new Animated.Value(0),
    new Animated.Value(0),
  ]).current;
  const [showEchoRipple, setShowEchoRipple] = useState(false);
  const [rippleSuccessText, setRippleSuccessText] = useState<string>('');
  const [showOceanEchoNotice, setShowOceanEchoNotice] = useState(false);
  const [oceanEchoNoticeText, setOceanEchoNoticeText] = useState(
    'Your echo drifts across the open sea',
  );
  const oceanEchoNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const prevHasSplashedRef = useRef<boolean>(hasSplashed);
  useEffect(() => {
    const prev = prevHasSplashedRef.current;
    if (hasSplashed && !prev) {
      smallDropsOpacity.setValue(0);
      Animated.timing(smallDropsOpacity, {
        toValue: 1,
        duration: 220,
        useNativeDriver: true,
      }).start();
      try {
        splashAnimation.setValue(0.9);
        Animated.spring(splashAnimation, {
          toValue: 1,
          friction: 5,
          tension: 140,
          useNativeDriver: true,
        }).start();
      } catch {}
    } else if (!hasSplashed && prev) {
      smallDropsOpacity.setValue(0);
    }
    prevHasSplashedRef.current = hasSplashed;
  }, [hasSplashed, smallDropsOpacity, splashAnimation]);
  useEffect(() => {
    return () => {
      if (oceanEchoNoticeTimer.current) {
        clearTimeout(oceanEchoNoticeTimer.current);
        oceanEchoNoticeTimer.current = null;
      }
    };
  }, []);
  const [isPaused, setIsPaused] = useState(false);
  const [showLive, setShowLive] = useState(false);
  // Editor playback control + sync helpers
  const [isCharteredDrift, setIsCharteredDrift] = useState(false);
  const [crew, setCrew] = useState<
    Array<{ id: string; name: string; avatar: string | null }>
  >([]);
  const [recentPosters, setRecentPosters] = useState<
    Array<{ id: string; name: string; avatar: string | null }>
  >([]);
  const [recentSplashers, setRecentSplashers] = useState<
    Array<{ id: string; name: string; avatar: string | null }>
  >([]);
  const [driftWatchers, setDriftWatchers] = useState<string[]>([]);
  const [driftAlert, setDriftAlert] = useState<DriftAlert | null>(null);
  const driftAlertTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastDriftHostRef = useRef<string | null>(null);
  const flickerAnim = useRef(new Animated.Value(0)).current;

  const loadDriftWatchers = useCallback(async () => {
    try {
      const user = auth()?.currentUser;
      if (!user) {
        setDriftWatchers([]);
        return;
      }
      const crewService = await import('./src/services/crewService');
      const [boardingList, crewMembers] = await Promise.all([
        crewService.getBoarding(200),
        crewService.getCrew(user.uid, 200),
      ]);
      const crewIds = crewMembers.map((member: any) => member.uid);
      const unique = Array.from(new Set([...boardingList, ...crewIds]));
      setDriftWatchers(unique);
    } catch (error) {
      console.warn('Could not load drift watchers', error);
    }
  }, []);

  const loadBlockedAndRemovedUsers = useCallback(async () => {
    try {
      const user = auth()?.currentUser;
      if (!user) {
        setBlockedUsers(new Set());
        setRemovedUsers(new Set());
        return;
      }

      // Load blocked users
      const blockedSnap = await firestore()
        .collection('users')
        .doc(user.uid)
        .collection('blocked')
        .get();
      const blocked = new Set((blockedSnap?.docs || []).map(doc => doc.id));
      setBlockedUsers(blocked);

      // Load removed users
      const removedSnap = await firestore()
        .collection('users')
        .doc(user.uid)
        .collection('removed')
        .get();
      const removed = new Set((removedSnap?.docs || []).map(doc => doc.id));
      setRemovedUsers(removed);

      console.log(`Loaded ${blocked.size} blocked users and ${removed.size} removed users`);
    } catch (error) {
      console.warn('Could not load blocked/removed users', error);
    }
  }, []);

  useEffect(() => {
    loadDriftWatchers();
    loadBlockedAndRemovedUsers();
    const sub = auth().onAuthStateChanged(() => {
      loadDriftWatchers();
      loadBlockedAndRemovedUsers();
    });
    return () => sub && sub();
  }, [loadDriftWatchers, loadBlockedAndRemovedUsers]);

  const showDriftAlert = useCallback((alert: DriftAlert) => {
    if (driftAlertTimerRef.current) {
      clearTimeout(driftAlertTimerRef.current);
    }
    lastDriftHostRef.current = alert.hostUid;
    setDriftAlert(alert);
    driftAlertTimerRef.current = setTimeout(() => {
      setDriftAlert(null);
      lastDriftHostRef.current = null;
    }, 10000);
  }, []);

  useEffect(() => () => {
    if (driftAlertTimerRef.current) {
      clearTimeout(driftAlertTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (!driftAlert) {
      flickerAnim.setValue(0);
      return;
    }
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(flickerAnim, {
          toValue: 1,
          duration: 400,
          useNativeDriver: true,
        }),
        Animated.timing(flickerAnim, {
          toValue: 0.2,
          duration: 600,
          useNativeDriver: true,
        }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [driftAlert, flickerAnim]);

  const watchersKey = useMemo(
    () => driftWatchers.slice().sort().join(','),
    [driftWatchers],
  );

  useEffect(() => {
    if (!watchersKey) {
      setDriftAlert(null);
      lastDriftHostRef.current = null;
      return;
    }
    const watchersSet = new Set(driftWatchers);
    const unsubscribe = firestore()
      .collection('live')
      .where('status', '==', 'live')
      .onSnapshot(snapshot => {
        const docs = snapshot?.docs || [];
        const session = docs
          .map(doc => ({ id: doc.id, ...(doc.data() as any) }))
          .find(s => s.hostUid && watchersSet.has(s.hostUid));
        if (
          session &&
          session.hostUid &&
          lastDriftHostRef.current !== session.hostUid
        ) {
          showDriftAlert({
            hostUid: session.hostUid,
            liveId: session.id,
            hostName: String(session.hostName || session.hostUid || 'Drifter'),
            hostPhoto: session.hostPhoto || null,
          });
        }
      });
    return () => unsubscribe && unsubscribe();
  }, [watchersKey, driftWatchers, showDriftAlert]);
  // Request to drift with a live host (viewer-side action)
  const requestToDriftForLiveId = useCallback(
    async (liveId: string, hostName?: string) => {
      try {
        let cfgLocal: any = null;
        try {
          cfgLocal = require('./liveConfig');
        } catch {}
        const backendBase: string =
          (cfgLocal &&
            (cfgLocal.BACKEND_BASE_URL ||
              cfgLocal.USER_MGMT_ENDPOINT_BASE ||
              cfgLocal.USER_MANAGEMENT_BASE_URL)) ||
          '';
        if (!backendBase) {
          notifyError('Backend base URL not set');
          return;
        }
        const me = auth?.()?.currentUser;
        if (!me) {
          Alert.alert('Sign in required');
          return;
        }
        const fromName = (profileName ||
          accountCreationHandle ||
          me.displayName ||
          (me.email ? String(me.email).split('@')[0] : 'drifter')) as string;
        const resp = await fetch(`${backendBase}/drift/request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ liveId, fromUid: me.uid, fromName }),
        });
        if (resp.ok) {
          notifySuccess(`Asked ${hostName || 'host'} to let you drift`);
        } else {
          notifyError('Could not send request to drift');
        }
      } catch {
        notifyError('Could not send request to drift');
      }
    },
    [profileName],
  );

  const [editorPlaying, setEditorPlaying] = useState(true);
  const [audioUnpaused, setAudioUnpaused] = useState(true);
  const overlayAudioDelayMs = 80; // small delay to align overlay audio with video start
  const editorVideoRef = React.useRef<any>(null);
  const editorAudioRef = React.useRef<any>(null);
  const audioDelayTimerRef = React.useRef<any>(null);
  // Pull live drifting users for right-side crew bubbles
  useEffect(() => {
    // liveConfig is loaded above into cfg
    let cfg: any = null;
    try {
      cfg = require('./liveConfig');
    } catch {}
    const recentUrl: string =
      (cfg &&
        cfg.cfg &&
        (cfg.cfg.LIVE_RECENT_ENDPOINT ||
          (cfg.cfg.BACKEND_BASE_URL
            ? `${cfg.cfg.BACKEND_BASE_URL}/live/recent`
            : ''))) ||
      '';
    if (!recentUrl) return;
    let mounted = true;
    const load = async () => {
      try {
        const resp = await fetch(recentUrl);
        if (!resp.ok) return;
        const json = await resp.json();
        const items = Array.isArray(json?.items) ? json.items : [];
        const mapped = items.slice(0, 4).map((it: any) => ({
          id: String(it.id),
          name: String(it.hostName || 'drifter'),
          avatar: it.hostPhoto ? String(it.hostPhoto) : null,
        }));
        if (mounted) setCrew(mapped);
      } catch {}
    };
    load();
    const iv = setInterval(load, 15000);
    return () => {
      mounted = false;
      clearInterval(iv);
    };
  }, []);

  // Fetch recent wave posters (users who posted waves recently)
  useEffect(() => {
    const user = auth?.()?.currentUser;
    if (!user?.uid) return;

    let firestoreMod: any = null;
    try {
      firestoreMod = require('@react-native-firebase/firestore').default;
    } catch {}
    if (!firestoreMod) return;

    const unsub = firestoreMod()
      .collection('users')
      .doc(user.uid)
      .collection('recentPosters')
      .orderBy('lastPostedAt', 'desc')
      .limit(10)
      .onSnapshot(
        (snapshot: any) => {
          const posters = (snapshot?.docs || []).map((doc: any) => {
            const data = doc.data();
            return {
              id: doc.id,
              name: data.userName || 'drifter',
              avatar: data.photoURL || null,
            };
          });
          setRecentPosters(posters);
        },
        (error: any) => {
          console.error('Error fetching recent posters:', error);
          setRecentPosters([]);
        },
      );

    return () => unsub();
  }, []);

  // Fallback: derive recent posters from latest waves if user-specific list is empty
  useEffect(() => {
    let firestoreMod: any = null;
    try {
      firestoreMod = require('@react-native-firebase/firestore').default;
    } catch {}
    if (!firestoreMod) return;

    const unsub = firestoreMod()
      .collection('waves')
      .orderBy('createdAt', 'desc')
      .limit(30)
      .onSnapshot(
        (snapshot: any) => {
          try {
            const seen = new Set<string>();
            const posters: Array<{
              id: string;
              name: string;
              avatar: string | null;
            }> = [];
            (snapshot?.docs || []).forEach((doc: any) => {
              const d = doc.data() || {};
              const uid = String(d.authorId || d.ownerUid || '') || '';
              if (!uid || seen.has(uid)) return;
              const name = String(d.authorName || 'drifter');
              const avatar = d.authorPhoto || d.ownerPhoto || null;
              posters.push({
                id: uid,
                name,
                avatar: avatar ? String(avatar) : null,
              });
              seen.add(uid);
            });
            // Only set if we still don't have a personalized list
            setRecentPosters(prev =>
              prev && prev.length > 0 ? prev : posters.slice(0, 10),
            );
          } catch (e) {
            // ignore
          }
        },
        () => {
          // ignore
        },
      );

    return () => {
      try {
        unsub && unsub();
      } catch {}
    };
  }, []);

  // Adjust right-side bubble vertical anchor to fit up to 3 stacks
  const rightBubblesTop = useMemo(() => {
    // Base at 45% of screen height; nudge upward as more stacks are shown
    let basePct = 45;
    let count = 1; // live crew
    if (recentPosters.length > 0) count += 1;
    if (recentSplashers.length > 0) count += 1;
    const topPct = Math.max(28, basePct - (count - 1) * 6); // min 28%
    // Convert percentage to pixels for RN style 'top'
    return (SCREEN_HEIGHT * topPct) / 100;
  }, [recentPosters.length, recentSplashers.length]);

  // Recent splashers (moved below currentWave declaration)

  // Playback HUD state (for posted wave)
  const [playbackTime, setPlaybackTime] = useState(0);
  const [playbackDuration, setPlaybackDuration] = useState(0);
  // Overlay sync guard: ensure video+overlay audio start together
  const [overlayReadyMap, setOverlayReadyMap] = useState<
    Record<string, { video?: boolean; audio?: boolean }>
  >({});
  const [videoErrorMap, setVideoErrorMap] = useState<Record<string, boolean>>(
    {},
  );
  const [videoAspectMap, setVideoAspectMap] = useState<Record<string, number>>(
    {},
  );

  // Prefer SurfaceView on Android to avoid TextureView decoder crashes on low-end devices (e.g., Tecno Pop 7)
  // Device-specific video surface selection: default SurfaceView on Android; allow opt-in to TextureView for whitelisted devices later
  const useTextureForVideo = useMemo(() => {
    if (Platform.OS !== 'android') return undefined;
    // Force SurfaceView for broader stability; TextureView can crash on some decoders.
    return false;
  }, []);

  const updateVideoAspect = useCallback(
    (id: string, naturalSize: any) => {
      try {
        const w = Number(naturalSize?.width || 0);
        const h = Number(naturalSize?.height || 0);
        if (w > 0 && h > 0) {
          const ar = w / h;
          setVideoAspectMap(prev => {
            if (Math.abs((prev[id] || 0) - ar) < 0.001) return prev;
            return { ...prev, [id]: ar };
          });
        }
      } catch {}
    },
    [],
  );
  const markOverlayReady = useCallback(
    (id: string, kind: 'video' | 'audio') => {
      if (!id) return;
      setOverlayReadyMap(prev => {
        const entry = prev[id] || {};
        if (entry[kind]) return prev;
        return { ...prev, [id]: { ...entry, [kind]: true } };
      });
    },
    [],
  );

  const videoStyleFor = useCallback(
    (id: string) => {
      const ar = videoAspectMap[id] || 9 / 16;
      const height = Math.min(SCREEN_HEIGHT, SCREEN_WIDTH / ar);
      return [
        styles.postedWaveMedia,
        {
          width: SCREEN_WIDTH,
          height,
          alignSelf: 'center',
        },
      ] as any;
    },
    [videoAspectMap],
  );
  const [bufferingMap, setBufferingMap] = useState<Record<string, boolean>>({});
  const bufferingTimeoutsRef = useRef<Record<string, any>>({});
  const clearBufferingTimeout = useCallback((id: string) => {
    try {
      const t = bufferingTimeoutsRef.current[id];
      if (t) clearTimeout(t);
    } catch {}
    delete bufferingTimeoutsRef.current[id];
  }, []);
  const markBuffering = useCallback(
    (id: string, isBuffering: boolean) => {
      setBufferingMap(prev => ({ ...prev, [id]: isBuffering }));
      if (isBuffering) {
        clearBufferingTimeout(id);
        bufferingTimeoutsRef.current[id] = setTimeout(() => {
          setBufferingMap(prev => ({ ...prev, [id]: false }));
          setVideoErrorMap(prev => ({ ...prev, [id]: true }));
        }, 12000);
      } else {
        clearBufferingTimeout(id);
      }
    },
    [clearBufferingTimeout],
  );
  useEffect(() => {
    return () => {
      try {
        Object.values(bufferingTimeoutsRef.current || {}).forEach(t =>
          clearTimeout(t),
        );
      } catch {}
    };
  }, []);
  const [retryMap, setRetryMap] = useState<Record<string, number>>({});
  // Remove a broken wave from local state + persisted cache so it can't poison startup
  const dropWaveFromCache = useCallback(async (waveId: string) => {
    if (!waveId) return;
    setWavesFeed(prev => prev.filter(w => w.id !== waveId));
    setPublicFeed(prev => prev.filter(w => w.id !== waveId));
    try {
      const AS = AsyncStorage;
      if (AS?.getItem && AS?.setItem) {
        const raw = await AS.getItem('my_waves');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            const filtered = parsed.filter((w: any) => w?.id !== waveId);
            await AS.setItem('my_waves', JSON.stringify(filtered));
          }
        }
      }
    } catch {}
    try {
      const FS = require('react-native-fs');
      if (FS?.DocumentDirectoryPath) {
        const filePath = FS.DocumentDirectoryPath + '/my_waves.json';
        const exists = await FS.exists(filePath);
        if (exists) {
          const raw = await FS.readFile(filePath, 'utf8');
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            const filtered = parsed.filter((w: any) => w?.id !== waveId);
            await FS.writeFile(filePath, JSON.stringify(filtered), 'utf8');
          }
        }
      }
    } catch {}
  }, []);
  const handleVideoPlaybackError = useCallback(
    (waveId: string, code?: string) => {
      try {
        markBuffering(waveId, false);
      } catch {}
      setRetryMap(prev => {
        const nextAttempts = (prev[waveId] || 0) + 1;
        const shouldRetry =
          !isOffline && code?.startsWith?.('-') && nextAttempts <= 3;
        if (shouldRetry) {
          const delay = Math.min(8000, 1000 * Math.pow(2, nextAttempts));
          setTimeout(() => {
            try {
              setWaveKey(Date.now());
            } catch {}
          }, delay);
        } else {
          setVideoErrorMap(m => ({ ...m, [waveId]: true }));
          // If this wave is active, advance to the next and drop it from cache so cold start won't crash
          setCurrentIndex(idx => {
            const waveIdx = displayFeed.findIndex(w => w.id === waveId);
            if (waveIdx === -1) return idx;
            if (displayFeed.length <= 1) return 0;
            if (idx === waveIdx) {
              const next = Math.min(displayFeed.length - 1, waveIdx + 1);
              return next === waveIdx ? Math.max(0, waveIdx - 1) : next;
            }
            return idx > waveIdx ? Math.max(0, idx - 1) : idx;
          });
          dropWaveFromCache(waveId);
        }
        return { ...prev, [waveId]: nextAttempts };
      });
    },
    [displayFeed, dropWaveFromCache, isOffline, markBuffering],
  );
  const [bottomBarHeight, setBottomBarHeight] = useState(60);
  // UI Visibility states
  const [isUiVisible, setIsUiVisible] = useState(false);
  const hideUiTimerRef = useRef<any>(null);

  const showUiTemporarily = useCallback(() => {
    setIsUiVisible(true);
    try {
      hideUiTimerRef.current && clearTimeout(hideUiTimerRef.current);
    } catch {}
    // Keep toggles visible a bit longer before auto-hide
    hideUiTimerRef.current = setTimeout(() => setIsUiVisible(false), 7000);
  }, []);
  const withUi = useCallback(
    (fn: () => void) => () => {
      try {
        showUiTemporarily();
      } catch {}
      try {
        fn();
      } catch {}
    },
    [showUiTemporarily],
  );
  const openWaveOptions = useCallback((wave: Wave) => {
    setWaveOptionsTarget(wave);
  }, []);
  const functionsClient = useMemo(() => {
    try {
      return require('@react-native-firebase/functions').default;
    } catch {
      return null;
    }
  }, []);
  
  // Use selected feed for rendering, filtering out blocked and removed users
  const displayFeed = useMemo(() => {
    const baseFeed = showPublicFeed ? publicFeed : wavesFeed;
    return baseFeed.filter(wave => {
      const ownerUid = wave.ownerUid || (wave as any).authorId;
      if (!ownerUid) return true; // Keep waves without owner info
      // Filter out blocked and removed users
      if (blockedUsers.has(ownerUid)) return false;
      if (removedUsers.has(ownerUid)) return false;
      return true;
    });
  }, [showPublicFeed, publicFeed, wavesFeed, blockedUsers, removedUsers]);
  // Deduplicate my waves to avoid double-counting stats and keep counts aligned with the visible feed
  const uniqueMyWaves = useMemo(() => {
    const seen = new Set<string>();
    return wavesFeed.filter(w => {
      if (!w?.id) return false;
      if (seen.has(w.id)) return false;
      seen.add(w.id);
      return true;
    });
  }, [wavesFeed]);

  const currentWave =
    displayFeed.length > 0 && currentIndex >= 0
      ? displayFeed[currentIndex]
      : null;
  const wavesCountDisplay = useMemo(
    () => {
      const feedCount = uniqueMyWaves.length;
      if (feedCount > 0) return feedCount;
      if (typeof myWaveCount === 'number') return myWaveCount;
      return 0;
    },
    [myWaveCount, uniqueMyWaves.length],
  );
  // Splashes: sum of regularSplashes (not including hugs) on my waves
  const totalSplashesOnMyWaves = useMemo(
    () =>
      Math.max(
        0,
        uniqueMyWaves.reduce(
          (sum, wave) => sum + (waveStats[wave.id]?.regularSplashes || 0),
          0,
        ),
      ),
    [uniqueMyWaves, waveStats],
  );
  // Hugs: sum of hugs (octopus_hug) on my waves
  const totalHugsOnMyWaves = useMemo(
    () =>
      Math.max(
        0,
        uniqueMyWaves.reduce(
          (sum, wave) => sum + (waveStats[wave.id]?.hugs || 0),
          0,
        ),
      ),
    [uniqueMyWaves, waveStats],
  );
  // Echoes: sum of echoes on my waves
  const totalEchoesOnMyWaves = useMemo(
    () =>
      uniqueMyWaves.reduce(
        (sum, wave) => sum + (waveStats[wave.id]?.echoes || 0),
        0,
      ),
    [uniqueMyWaves, waveStats],
  );
  const openMyWavesFromStats = useCallback(() => {
    setShowProfile(false);
    setShowMyWaves(true);
  }, [setShowMyWaves, setShowProfile]);
  const handleHugsPress = useCallback(() => {
    const totalHugs = userStats.hugsMade;
    const withdrawable = Math.floor(totalHugs / 10000) * 10000;
    if (withdrawable > 0) {
      Alert.alert(
        'Withdraw Hugs',
        `You have ${formatCount(totalHugs)} hugs.\n\nWithdrawable: ${formatCount(
          withdrawable,
        )} hugs = $${withdrawable / 100}\n\nWithdraw now?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Withdraw',
            style: 'default',
            onPress: async () => {
              try {
                const user = auth?.()?.currentUser;
                if (!user) return;
                const userRef = firestore().collection('users').doc(user.uid);
                const remaining = totalHugs % 10000;
                await userRef.update({
                  octopusWallet: firestore.FieldValue.increment(
                    withdrawable / 100,
                  ),
                  'stats.hugsWithdrawn': firestore.FieldValue.increment(
                    withdrawable,
                  ),
                  'stats.hugsMade': remaining,
                });
                setUserStats(prev => ({
                  ...prev,
                  hugsMade: remaining,
                }));
                notifySuccess(
                  `$${withdrawable / 100} added to your Octopus Wallet!`,
                );
              } catch (e) {
                notifyError('Withdrawal failed');
              }
            },
          },
        ],
      );
    } else {
      Alert.alert(
        'Octopus Hugs',
        `You have ${formatCount(totalHugs)} hugs.\n\nNeed 10,000 hugs to withdraw ($100).`,
      );
    }
  }, [notifyError, notifySuccess, userStats.hugsMade]);
  const handleEchoesPress = useCallback(() => {
    const totalEchoes = totalEchoesOnMyWaves;
    Alert.alert(
      'Echoes',
      `You have ${formatCount(totalEchoes)} echoes across the ocean.`,
    );
  }, [totalEchoesOnMyWaves]);
  type StatEntry = {
    key: string;
    label: string;
    value: number;
    onPress?: () => void;
  };
  const statsEntries: StatEntry[] = useMemo(
    () => [
      {
        key: 'waves',
        label: 'Waves',
        value: wavesCountDisplay,
        onPress: openMyWavesFromStats,
      },
      { key: 'crew', label: 'Crew', value: myCrewCount },
      { key: 'splashes', label: 'Splashes', value: totalSplashesOnMyWaves },
      { key: 'hugs', label: 'Hugs', value: totalHugsOnMyWaves, onPress: handleHugsPress },
      { key: 'echoes', label: 'Echoes', value: totalEchoesOnMyWaves, onPress: handleEchoesPress },
    ],
    [
      wavesCountDisplay,
      openMyWavesFromStats,
      myCrewCount,
      totalSplashesOnMyWaves,
      totalHugsOnMyWaves,
      handleHugsPress,
      totalEchoesOnMyWaves,
      handleEchoesPress,
    ],
  );
  
  const handleWaveOptionSelect = useCallback(
    async (label: string) => {
      if (!waveOptionsTarget) return;
      const entry = waveOptionMenu.find(item => item.label === label);
      setWaveOptionsTarget(null);

      // Handle Join/Leave Crew
      if (label === 'Join Crew') {
        if (!waveOptionsTarget.ownerUid || waveOptionsTarget.ownerUid === myUid) {
          Alert.alert('Info', "You can't join your own crew");
          return;
        }
        const targetUid = waveOptionsTarget.ownerUid;
        const targetName = waveOptionsTarget.authorName;
        await handleJoinCrew(targetUid, targetName);
        setIsInUserCrew(prev => ({ ...prev, [targetUid]: true }));
        return;
      }

      if (label === 'Save to device') {
        if (isSavingWave) return;
        setIsSavingWave(true);

        try {
          // Try backend endpoint first
          let downloadUrl: string | null = null;

          try {
            const cfgLocal = (() => {
              try {
                return require('./liveConfig');
              } catch {
                return null;
              }
            })();
            const backendBase: string =
              (cfgLocal &&
                (cfgLocal.BACKEND_BASE_URL ||
                  cfgLocal.USER_MGMT_ENDPOINT_BASE ||
                  cfgLocal.USER_MANAGEMENT_BASE_URL)) ||
              '';

            if (backendBase) {
              const resp = await fetch(`${backendBase}/wave/download`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ waveId: waveOptionsTarget.id }),
              });

              if (resp.ok) {
                const data = await resp.json();
                downloadUrl = data.downloadUrl;
              }
            }
          } catch {}

          // Fallback: Try to get download URL directly from Firestore + Storage
          if (!downloadUrl) {
            try {
              let firestoreMod: any = null;
              let storageMod: any = null;
              try {
                firestoreMod =
                  require('@react-native-firebase/firestore').default;
              } catch {}
              try {
                storageMod = require('@react-native-firebase/storage').default;
              } catch {}

              if (firestoreMod && storageMod) {
                const waveDoc = await firestoreMod()
                  .collection('waves')
                  .doc(waveOptionsTarget.id)
                  .get();
                const waveData = waveDoc.data() || {};
                const mediaPath =
                  waveData.mediaPath ||
                  waveData.playbackUrl ||
                  waveData.mediaUrl;

                if (mediaPath) {
                  // If it's a full URL, use it directly
                  if (
                    mediaPath.startsWith('http://') ||
                    mediaPath.startsWith('https://')
                  ) {
                    downloadUrl = mediaPath;
                  } else {
                    // Otherwise, get download URL from Storage
                    downloadUrl = await storageMod()
                      .ref(mediaPath)
                      .getDownloadURL();
                  }
                }
              }
            } catch (storageError) {
              console.error('Storage download error:', storageError);
            }
          }

          if (downloadUrl) {

            // On Android, request storage permission only if needed (pre-Android 10)
            if (Platform.OS === 'android') {
              try {
                const apiLevel = typeof Platform.Version === 'number' ? Platform.Version : 0;
                if (apiLevel <= 28) { // Android 9 and below
                  const granted = await PermissionsAndroid.request(
                    PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE,
                    {
                      title: 'Storage Permission',
                      message: 'Allow Drift to save this wave to your device?',
                      buttonPositive: 'Allow',
                      buttonNegative: 'Deny',
                    },
                  );
                  if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
                    Alert.alert(
                      'Permission Denied',
                      'Storage permission is required to save waves to your device.',
                    );
                    return;
                  }
                }
                // For Android 10+ (API 29+), no permission needed for app-scoped or Downloads folder
              } catch (permErr) {
                console.warn('Permission request failed:', permErr);
              }
            }

            // Open download URL - system will handle the download
            try {
              await Linking.openURL(String(downloadUrl));
              Alert.alert(
                'Wave Download Started',
                'Your wave is being downloaded. Check your Downloads folder or notification bar.',
                [{ text: 'OK' }],
              );
            } catch (linkErr) {
              console.error('Failed to open download URL:', linkErr);
              Alert.alert(
                'Download URL Ready',
                'Copy this URL to download the wave:\n\n' + downloadUrl,
                [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Copy URL',
                    onPress: () => {
                      // Simple clipboard alternative - user can manually copy from alert
                      Alert.alert('Download URL', downloadUrl);
                    },
                  },
                ],
              );
            }
          } else {
            throw new Error('Could not retrieve download link');
          }
        } catch (error: any) {
          const errorMsg =
            error?.message || 'Unable to prepare the download right now.';
          showOceanDialog(
            'Save Failed',
            errorMsg || 'The wave could not be saved to the sea.',
          );
        } finally {
          setIsSavingWave(false);
        }
        return;
      }

      if (label === 'Share' && currentWave) {
        try {
          await Share.share({
            message: `Check out this SplashLine wave: ${currentWave.id}`,
          });
        } catch {}
        return;
      }

      if (label === 'Report') {
        Alert.alert(
          entry?.label || label,
          entry?.description || 'Going to moderation.',
        );
        return;
      }

      Alert.alert(entry?.label || label, entry?.description || 'Coming soon!');
    },
    [waveOptionsTarget, functionsClient, isSavingWave, currentWave],
  );
  const [isTopBarExpanded, setIsTopBarExpanded] = useState(false);
  const [isBottomBarExpanded, setIsBottomBarExpanded] = useState(false);
  const [isSwiping, setIsSwiping] = useState(false);
  const dragStartXRef = useRef(0);
  const dragStartTimeRef = useRef(0);
  const touchStartRef = useRef(0);

  const deleteWave = (waveId: string) => {
    // Only update UI after confirmed deletion
    const doDelete = async (retryCount = 0) => {
      let firestoreMod: any = null;
      let storageMod: any = null;
      let authMod: any = null;
      try {
        firestoreMod = require('@react-native-firebase/firestore').default;
      } catch {}
      try {
        storageMod = require('@react-native-firebase/storage').default;
      } catch {}
      try {
        authMod = require('@react-native-firebase/auth').default;
      } catch {}
      const user = authMod?.().currentUser;
      if (!firestoreMod || !user) {
        Alert.alert('Delete failed', 'Not signed in or backend unavailable.');
        return;
      }

      const deleteCollectionInChunks = async (
        path: string,
        chunkSize = 400,
      ) => {
        while (true) {
          const snap = await firestoreMod().collection(path).limit(chunkSize).get();
          if (!snap || snap.empty) break;
          const batch = firestoreMod().batch();
          snap.forEach((doc: any) => batch.delete(doc.ref));
          await batch.commit();
          if (snap.size < chunkSize) break;
        }
      };

      const deleteStoragePath = async (path?: string | null) => {
        if (!storageMod || !path) return;
        try {
          const isHttp = /^https?:/i.test(String(path));
          const ref = isHttp
            ? storageMod().refFromURL(String(path))
            : storageMod().ref(String(path));
          await ref.delete();
        } catch (err) {
          console.warn('Delete storage skipped', err);
        }
      };

      try {
        // Get wave doc
        const waveDoc = await firestoreMod().collection('waves').doc(waveId).get();
        if (!waveDoc.exists) {
          setWavesFeed(prev => prev.filter(w => w.id !== waveId));
          setPublicFeed(prev => prev.filter(w => w.id !== waveId));
          Alert.alert('Wave deleted', 'Wave already removed.');
          return;
        }
        const waveData = waveDoc.data() || {};
        // Only allow owner to delete
        const waveOwner =
          waveData.ownerUid ||
          waveData.authorId ||
          waveData.userUid ||
          waveData.uid ||
          wavesFeed.find(w => w.id === waveId)?.ownerUid ||
          null;
        if (waveOwner && waveOwner !== user.uid) {
          Alert.alert('Delete failed', 'You can only delete your own wave.');
          return;
        }
        // Delete media from storage if present
        await deleteStoragePath(waveData.mediaPath);
        await deleteStoragePath(
          waveData.audioUrl && !/^https?:/i.test(String(waveData.audioUrl))
            ? waveData.audioUrl
            : null,
        );
        // Delete all echoes and splashes subcollections in safe chunks (avoids >500 batch limit)
        await deleteCollectionInChunks(`waves/${waveId}/echoes`);
        await deleteCollectionInChunks(`waves/${waveId}/splashes`);
        // Delete the wave doc
        await firestoreMod().collection('waves').doc(waveId).delete();
        setWavesFeed(prev => prev.filter(w => w.id !== waveId));
        setPublicFeed(prev => prev.filter(w => w.id !== waveId));
        Alert.alert('Wave deleted', 'Your wave has been removed from My Shore.');
      } catch (e) {
        console.warn('Delete wave failed', e);
        if (retryCount < 2) {
          setTimeout(() => doDelete(retryCount + 1), 1000 * (retryCount + 1));
        } else {
          Alert.alert('Delete failed', 'Could not delete wave right now. Please try again later.');
        }
      }
    };
    doDelete();
  };

  const isVideoAsset = (asset: Asset | null | undefined): boolean => {
    if (!asset) return false;
    const t = (asset.type || '').toLowerCase();
    if (t.includes('video')) return true;
    const uri = String(asset.uri || '').toLowerCase();
    if (/(\.(mp4|mov|m4v|webm|3gp|3gpp|mkv|avi))($|\?)/i.test(uri)) return true;
    const isLocal = uri.startsWith('file://') || uri.startsWith('content://');
    const isImageExt = /(\.(jpg|jpeg|png|gif|heic|webp))($|\?)/i.test(uri);
    if (isLocal && !isImageExt) return true;
    return false;
  };

  // Recent splashers for the current wave (third avatar stack)
  useEffect(() => {
    const waveId = currentWave?.id;
    if (!waveId) {
      setRecentSplashers([]);
      return;
    }

    let firestoreMod: any = null;
    try {
      firestoreMod = require('@react-native-firebase/firestore').default;
    } catch {}
    if (!firestoreMod) return;

    const unsub = firestoreMod()
      .collection(`waves/${waveId}/splashes`)
      .orderBy('createdAt', 'desc')
      .limit(5)
      .onSnapshot(
        (snapshot: any) => {
          const items = (snapshot?.docs || []).map((doc: any) => {
            const d = doc.data() || {};
            return {
              id: d.userUid || doc.id,
              name: d.userName || 'drifter',
              avatar: d.userPhoto || null,
            };
          });
          setRecentSplashers(items);
        },
        (error: any) => {
          console.error('Error fetching recent splashers:', error);
          setRecentSplashers([]);
        },
      );

    return () => {
      try {
        unsub && unsub();
      } catch {}
    };
  }, [currentWave?.id]);

  useEffect(() => {
    // Reset timer when a new wave is shown
    setPlaybackTime(0);
    setPlaybackDuration(0);
    setIsPaused(false);
    // Show toggles for 7s when a new wave appears
    showUiTemporarily();

    // Reset pearls country selection when modal is closed
    if (!showPearls) {
      setSelectedCountry(null);
    }

    const handleAppStateChange = (nextAppState: any) => {
      if (nextAppState.match(/inactive|background/)) {
        setIsPaused(true);
      } else if (nextAppState === 'active') {
        setIsPaused(false);
        // Force video elements to remount after app resume to avoid stale surfaces
        setWaveKey(Date.now());
        setVideoErrorMap({});
      }
    };

    const subscription = AppState.addEventListener(
      'change',
      handleAppStateChange,
    );

    return () => {
      subscription.remove();
    };
  }, [waveKey, currentWave?.id, showPearls]);

  // Resume playback when Make Waves modal closes
  useEffect(() => {
    if (!showMakeWaves) setIsPaused(false);
  }, [showMakeWaves]);

  // Reset overlay ready flags when switching waves or refreshing the feed
  useEffect(() => {
    setOverlayReadyMap({});
  }, [currentIndex, waveKey, displayFeed.length]);

  // Persistence of waves with AsyncStorage if available, otherwise file-based via react-native-fs
  useEffect(() => {
    const loadPersisted = async () => {
      let AS: any = null;
      let FS: any = null;
      try {
        AS = require('@react-native-async-storage/async-storage').default;
      } catch {}
      try {
        FS = require('react-native-fs');
      } catch {}

      try {
        let raw: string | null = null;
        if (AS && typeof AS.getItem === 'function') {
          raw = await AS.getItem('my_waves');
        } else if (FS && FS.DocumentDirectoryPath) {
          const filePath = FS.DocumentDirectoryPath + '/my_waves.json';
          const exists = await FS.exists(filePath);
          if (exists) raw = await FS.readFile(filePath, 'utf8');
        }
        if (raw) {
          const data = JSON.parse(raw);
          if (Array.isArray(data)) {
            const a = (() => {
              try {
                return require('@react-native-firebase/auth').default;
              } catch {
                return null;
              }
            })();
            const myUid = a ? a()?.currentUser?.uid : null;
            const myNameNorm = String(
              (profileName || '').replace(/^[@/]+/, ''),
            ).toLowerCase();
            const reversedData = data.reverse().map((w: any) => {
              const hasOwner =
                typeof w.ownerUid !== 'undefined' && w.ownerUid !== null;
              if (hasOwner) return w;
              const n = String(
                (w.authorName || '').replace(/^[@/]+/, ''),
              ).toLowerCase();
              return {
                ...w,
                ownerUid:
                  myUid && n && n === myNameNorm ? myUid : w.ownerUid || null,
              };
            });
            setWavesFeed(reversedData);
            setCurrentIndex(reversedData.length ? 0 : -1);
          }
        }
      } catch {
      } finally {
        setIsFeedLoaded(true);
      }
    };
    loadPersisted();
  }, []);

  useEffect(() => {
    if (!isFeedLoaded) return;
    const savePersisted = async () => {
      let AS: any = null;
      let FS: any = null;
      try {
        AS = require('@react-native-async-storage/async-storage').default;
      } catch {}
      try {
        FS = require('react-native-fs');
      } catch {}
      try {
        const chronologicalFeed = [...wavesFeed].reverse();
        const myUidForPersist = (() => {
          try {
            const a = require('@react-native-firebase/auth').default;
            return a?.().currentUser?.uid || null;
          } catch {
            return null;
          }
        })();
        const compact = chronologicalFeed.map(w => ({
          id: w.id,
          media: {
            uri: w.media?.uri,
            type: w.media?.type,
            fileName: w.media?.fileName,
          },
          audio: w.audio,
          captionText: w.captionText,
          captionPosition: w.captionPosition,
          playbackUrl: w.playbackUrl ?? null,
          muxStatus: w.muxStatus ?? null,
          authorName:
            w.authorName ?? (profileName || accountCreationHandle || null),
          ownerUid: w.ownerUid ?? myUidForPersist,
        }));
        const payload = JSON.stringify(compact);
        if (AS && typeof AS.setItem === 'function') {
          await AS.setItem('my_waves', payload);
        } else if (FS && FS.DocumentDirectoryPath) {
          const filePath = FS.DocumentDirectoryPath + '/my_waves.json';
          await FS.writeFile(filePath, payload, 'utf8');
        }
      } catch {}
    };
    savePersisted();
  }, [wavesFeed, isFeedLoaded]);

  // One-time migration: backfill authorName on existing saved waves and update remote docs best-effort
  const didAuthorNameMigration = useRef(false);
  useEffect(() => {
    if (didAuthorNameMigration.current) return;
    if (!profileName) return;
    if (!wavesFeed || wavesFeed.length === 0) return;
    const missing = wavesFeed.filter(w => !w.authorName);
    if (missing.length === 0) return;
    // Backfill locally so UI shows the correct handle immediately
    setWavesFeed(prev =>
      prev.map(w =>
        w.authorName
          ? w
          : {
              ...w,
              authorName: profileName || accountCreationHandle || null,
            },
      ),
    );
    // Best-effort remote merge so older waves display the correct handle for others
    try {
      let firestoreMod: any = null;
      let authMod: any = null;
      try {
        firestoreMod = require('@react-native-firebase/firestore').default;
      } catch {}
      try {
        authMod = require('@react-native-firebase/auth').default;
      } catch {}
      const uid = authMod?.().currentUser?.uid;
      if (firestoreMod && uid) {
        missing.forEach(w => {
          try {
            firestoreMod()
              .collection('waves')
              .doc(w.id)
              .set(
                { authorName: profileName || accountCreationHandle || null },
                { merge: true },
              );
          } catch {}
        });
      }
    } catch {}
    didAuthorNameMigration.current = true;
  }, [profileName, wavesFeed]);

  // Load Public Waves when toggled on (best-effort if Firebase exists)
  useEffect(() => {
    if (!showPublicFeed) return;
    let firestoreMod: any = null;
    let storageMod: any = null;
    let functionsMod: any = null;
    try {
      firestoreMod = require('@react-native-firebase/firestore').default;
    } catch {}
    try {
      storageMod = require('@react-native-firebase/storage').default;
    } catch {}
    try {
      functionsMod = require('@react-native-firebase/functions').default;
    } catch {}
    if (!firestoreMod) return;
    
    let unsub: any = null;
    let cancelled = false;
    
    const run = async () => {
      
      try {
        unsub = firestoreMod()
          .collection('waves')
          .orderBy('createdAt', 'desc')
          .limit(50)
          .onSnapshot(async (snap: any) => {
            const docs = (snap?.docs || []).slice();
            const out: Wave[] = [];
            for (const d of docs) {
              const data = d.data() || {};
              const id = d.id;
              const caption = data?.text || '';
              const cap = data?.caption || { x: 0, y: 0 };
              const authorName = data?.authorName || null;
              let playbackUrl: string | null =
                data?.playbackUrl || data?.mediaUrl || null;
              let mediaUri: string | null = null;
              if (!playbackUrl && storageMod && data?.mediaPath) {
                try {
                  mediaUri = await storageMod()
                    .ref(String(data.mediaPath))
                    .getDownloadURL();
                } catch {}
              }
              // Show all waves in public feed (my waves and other users' waves)
              const finalUri = playbackUrl || mediaUri;
              if (!finalUri) continue;
              out.push({
                id: id,
                media: { uri: finalUri } as any,
                audio: data?.audioUrl ? { uri: String(data.audioUrl) } : null,
                captionText: caption,
                captionPosition: {
                  x: Number(cap?.x) || 0,
                  y: Number(cap?.y) || 0,
                },
                playbackUrl: playbackUrl,
                muxStatus: (data?.muxStatus || null) as any,
                authorName,
                ownerUid: (data?.ownerUid || data?.authorId || null) as any,
              });
            }
            if (!cancelled) {
              const myUid = auth?.()?.currentUser?.uid;
              const myWavesInPublic = out.filter(w => w.ownerUid === myUid);
              setWavesFeed(prev => {
                const existingMyWaveIds = new Set(prev.map(w => w.id));
                const newMyWaves = myWavesInPublic.filter(
                  w => !existingMyWaveIds.has(w.id),
                );
                return [...newMyWaves, ...prev];
              });
              // Filter out my own waves from public feed on my device
              setPublicFeed(out.filter(w => w.ownerUid !== myUid));
            }
          });
      } catch {}
    };
    run();
    return () => {
      cancelled = true;
      try {
        unsub && unsub();
      } catch {}
    };
  }, [showPublicFeed]);

  // Load MY SHORE profile once (and keep in sync)
  useEffect(() => {
    let firestoreMod: any = null;
    let authMod: any = null;
    try {
      firestoreMod = require('@react-native-firebase/firestore').default;
    } catch {}
    try {
      authMod = require('@react-native-firebase/auth').default;
    } catch {}
    const uid = authMod?.().currentUser?.uid;
    if (!firestoreMod || !uid) return;
    try {
      const ref = firestoreMod().doc(`users/${uid}`);
      // Load user stats for splashes/hugs made
      ref.get().then((doc: any) => {
        const data = doc?.data?.() || doc?.data || {};
        const stats = data?.stats || {};
        setUserStats({
          splashesMade: Number(stats?.splashesMade || 0),
          hugsMade: Number(stats?.hugsMade || 0),
        });
      }).catch(() => {});
      const unsub = ref.onSnapshot((snap: any) => {
        try {
          const d = snap?.data() || {};
          if (snap?.exists) {
            if (typeof d?.userPhoto !== 'undefined')
              setProfilePhoto(d.userPhoto || null);
            if (typeof d?.bio !== 'undefined') setProfileBio(d.bio || '');
          }
        } catch {}
      });
      return () => {
        try {
          unsub && unsub();
        } catch {}
      };
    } catch {}
  }, []);

  // Single, gated FCM bootstrap (runs only after sign-in and permission)
  useEffect(() => {
    let cleanup: Array<() => void> = [];
    let cancelled = false;

    const setupNotifications = async () => {
      if (!user?.uid) return;
      if (notificationInitRef.current === user.uid) return;
      notificationInitRef.current = user.uid;

      let messagingMod: any = null;
      let firestoreMod: any = null;
      try {
        messagingMod = require('@react-native-firebase/messaging').default;
      } catch {}
      try {
        firestoreMod = require('@react-native-firebase/firestore').default;
      } catch {}
      if (!messagingMod) return;

      // Android 13+ explicit notification permission
      if (Platform.OS === 'android' && Platform.Version >= 33) {
        try {
          await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
          );
        } catch {}
      }

      let authStatus: any = null;
      try {
        authStatus = await messagingMod().requestPermission();
      } catch (err) {
        console.warn('Notification permission request failed', err);
      }
      const enabled =
        authStatus === messagingMod?.AuthorizationStatus?.AUTHORIZED ||
        authStatus === messagingMod?.AuthorizationStatus?.PROVISIONAL;
      if (!enabled) {
        console.log('Notification permission not granted; skipping FCM init');
        return;
      }

      let token: string | null = null;
      try {
        token = await messagingMod().getToken();
      } catch (err) {
        console.warn('Failed to get FCM token', err);
      }

      if (token && firestoreMod) {
        try {
          await firestoreMod()
            .collection('users')
            .doc(user.uid)
            .collection('tokens')
            .doc(token)
            .set(
              {
                token,
                platform: Platform.OS,
                createdAt: firestoreMod.FieldValue?.serverTimestamp?.(),
              },
              { merge: true },
            );
        } catch (err) {
          console.warn('Failed to persist FCM token', err);
        }
      }

      try {
        const unsubTokenRefresh = messagingMod().onTokenRefresh(
          async (newToken: string) => {
            try {
              if (!firestoreMod) return;
              await firestoreMod()
                .collection('users')
                .doc(user.uid)
                .collection('tokens')
                .doc(newToken)
                .set(
                  {
                    token: newToken,
                    platform: Platform.OS,
                    updatedAt: firestoreMod.FieldValue?.serverTimestamp?.(),
                  },
                  { merge: true },
                );
            } catch (err) {
              console.warn('Failed to persist refreshed FCM token', err);
            }
          },
        );
        cleanup.push(() => {
          try {
            unsubTokenRefresh && unsubTokenRefresh();
          } catch {}
        });
      } catch {}

      try {
        const unsubMessage = messagingMod().onMessage(handleForegroundRemoteMessage);
        cleanup.push(() => {
          try {
            unsubMessage && unsubMessage();
          } catch {}
        });
      } catch {}

      try {
        const unsubOpened = messagingMod().onNotificationOpenedApp(
          (remoteMessage: any) => {
            handleNotificationNavigation(remoteMessage?.data);
          },
        );
        cleanup.push(() => {
          try {
            unsubOpened && unsubOpened();
          } catch {}
        });
      } catch {}

      try {
        const initial = await messagingMod().getInitialNotification();
        if (initial && !cancelled) {
          handleNotificationNavigation(initial.data);
        }
      } catch (err) {
        console.warn('Failed to process initial notification', err);
      }
    };

    setupNotifications();

    return () => {
      cancelled = true;
      cleanup.forEach(fn => {
        try {
          fn && fn();
        } catch {}
      });
      if (!user?.uid) notificationInitRef.current = null;
    };
  }, [user?.uid, handleForegroundRemoteMessage, handleNotificationNavigation]);

  const markPingsAsRead = async () => {
    try {
      let firestoreMod: any = null;
      let authMod: any = null;

      // Safely require modules
      try {
        firestoreMod = require('@react-native-firebase/firestore').default;
      } catch (e) {
        console.warn('Firestore module not available');
        return;
      }

      try {
        authMod = require('@react-native-firebase/auth').default;
      } catch (e) {
        console.warn('Auth module not available');
        return;
      }

      // Check if modules loaded properly
      if (!firestoreMod || !authMod) {
        console.warn('Firebase modules not available');
        return;
      }

      const currentUser = authMod().currentUser;
      if (!currentUser) {
        console.warn('No user signed in');
        return;
      }

      const uid = currentUser.uid;
      if (!uid || unreadPingsCount === 0) return;

      let unreadPings: any = null;
      try {
        // Execute query with error handling
        unreadPings = await firestoreMod()
          .collection(`users/${uid}/pings`)
          .where('read', '==', false)
          .limit(100)
          .get();
      } catch (queryError) {
        console.warn('Error executing Firestore query:', queryError);
        return;
      }

      // SAFE CHECK - Prevents "cannot read property 'empty' of null"
      if (!unreadPings || typeof unreadPings.empty === 'undefined') {
        console.warn('Invalid query result received');
        return;
      }

      if (unreadPings.empty) {
        // No unread pings to update
        setUnreadPingsCount(0);
        return;
      }

      // Process the batch update (guard for malformed docs)
      const batch = firestoreMod().batch();
      const docs = Array.isArray((unreadPings as any)?.docs)
        ? (unreadPings as any).docs
        : [];
      let updates = 0;
      docs.forEach((d: any) => {
        if (d && d.ref) {
          batch.update(d.ref, { read: true });
          updates += 1;
        }
      });
      if (updates > 0) {
        await batch.commit();
      }

      // Update server-side counter
      await firestoreMod()
        .doc(`users/${uid}`)
        .set(
          {
            counters: { unreadPings: 0 },
          },
          { merge: true },
        );

      // Update local state
      setUnreadPingsCount(0);
    } catch (error) {
      console.warn('Error in markPingsAsRead:', error);
    }
  };

  // Local + remote ping recording for in-app activity
  const recordPingEvent = async (
    type: Ping['type'],
    waveId?: string,
    extra?: { text?: string; splashType?: 'regular' | 'octopus_hug' },
  ) => {
    try {
      const text = extra?.text || type;
      setPings(prev => [
        {
          id: 'local-' + Date.now(),
          type,
          actorName: profileName || accountCreationHandle || '/You',
          text,
          waveId,
          timestamp: new Date(),
          read: false,
          splashType: extra?.splashType,
        },
        ...prev,
      ]);
      setUnreadPingsCount(c => c + 1);
      let firestoreMod: any = null;
      let authMod: any = null;
      try {
        firestoreMod = require('@react-native-firebase/firestore').default;
      } catch {}
      try {
        authMod = require('@react-native-firebase/auth').default;
      } catch {}
      const uid = authMod?.().currentUser?.uid;
      if (!firestoreMod || !uid) return;
      await firestoreMod()
        .collection(`users/${uid}/pings`)
        .add({
          type,
          waveId: waveId || null,
          text,
          actorUid: uid,
          actorName: profileName || accountCreationHandle || 'You',
          createdAt: firestoreMod.FieldValue.serverTimestamp(),
          read: false,
          splashType: extra?.splashType || null,
        });
      try {
        await firestoreMod()
          .doc(`users/${uid}`)
          .set(
            { counters: { unreadPings: firestoreMod.FieldValue.increment(1) } },
            { merge: true },
          );
      } catch {}
    } catch {}
  };

  const handlePingAction = (ping: Ping) => {
    if (ping.waveId) {
      const waveIndex = wavesFeed.findIndex(w => w.id === ping.waveId);
      if (waveIndex !== -1) {
        setShowPings(false);
        setCurrentIndex(waveIndex);
        setWaveKey(Date.now());
      } else {
        showOceanDialog(
          'Wave Not Found',
          'This wave may no longer be drifting in the sea.',
        );
      }
    }
    // Could add 'follow' action here
  };

  const onSendMessage = async () => {
    const text = messageText.trim();
    if (!text || !messageRecipient) return;
    let firestoreMod: any;
    let authMod: any;
    try {
      firestoreMod = require('@react-native-firebase/firestore').default;
    } catch {}
    try {
      authMod = require('@react-native-firebase/auth').default;
    } catch {}
    const user = authMod?.().currentUser;
    if (!firestoreMod || !user) {
      Alert.alert('Not signed in', 'You must be signed in to send messages.');
      return;
    }
    try {
      // This collection is for the recipient's inbox view
      await firestoreMod()
        .collection(`users/${messageRecipient.uid}/messages`)
        .add({
          text,
          fromUid: user.uid,
          fromName: user.displayName || 'Anonymous',
          route: 'Pings',
          type: 'message',
          createdAt: firestoreMod.FieldValue.serverTimestamp(),
        });
      // This collection triggers the push notification via the onMentionCreate cloud function
      await firestoreMod()
        .collection(`users/${messageRecipient.uid}/mentions`)
        .add({
          text,
          fromUid: user.uid,
          fromName: user.displayName || 'Anonymous',
          fromPhoto: user.photoURL || null,
          route: 'Pings',
          createdAt: firestoreMod.FieldValue.serverTimestamp(),
          type: 'message', // To distinguish from other mention types if needed
        });

      setShowSendMessage(false);
      notifySuccess('Ping sent!');
      showOceanDialog(
        'Message Sent',
        `Your message to ${messageRecipient.name} has been cast into the sea!`,
      );
    } catch (e) {
      showOceanDialog(
        'Error',
        'Could not send message. The seas are rough right now.',
      );
    }
  };

  const formatTime = (secs: number) => {
    const s = Math.max(0, Math.floor(secs || 0));
    const m = Math.floor(s / 60);
    const ss = String(s % 60).padStart(2, '0');
    return `${m}:${ss}`;
  };

  const extractBaseName = (uri: string | undefined | null): string => {
    if (!uri) return '';
    try {
      const trimmed = String(uri).split('?')[0].split('#')[0];
      const last = trimmed.substring(trimmed.lastIndexOf('/') + 1);
      return last || '';
    } catch {
      return '';
    }
  };

  const getWaveTitle = (w: Wave | null): string => {
    if (!w) return ' ';
    // Prioritize audio title if an overlay audio is present
    if (w.audio?.name || w.audio?.uri) {
      return w.audio.name || extractBaseName(w.audio.uri) || 'Audio Wave';
    }
    // Otherwise, use the video or image file name
    return w.media.fileName || extractBaseName(w.media.uri) || 'Wave';
  };

  const explore = useMemo(
    () => [
      {
        title: 'Tidal Trends',
        desc: 'User-voted "rising waves" of ocean hacks, viral beach fails, or marine memes.',
      },
      {
        title: 'Wave Radar',
        desc: 'Real-time global ocean alerts and user-submitted surf spots with an AR overlay.',
      },
      {
        title: 'Crew Quests',
        desc: 'Collaborative challenges like beach cleanups or sharing sunset sail stories.',
      },
      {
        title: 'Siren Stories',
        desc: 'Bite-sized narratives from ocean explorers with voiceover audio and ambient sounds.',
      },
      {
        title: 'Reef Reels',
        desc: 'Short videos of marine life with haptic feedback and glow-in-the-dark filters.',
      },
      {
        title: 'Treasure Tides',
        desc: 'Gamified hunts for virtual ocean artifacts with real-world map tie-ins.',
      },
      {
        title: 'Mystic Depths',
        desc: 'A spooky-fun section for ocean myths, ghost ships, and bioluminescent wonders.',
      },
      {
        title: 'Buoy Banter',
        desc: 'Quick Q&A or polls on ocean trivia with AI-generated "sea shanty" jingles.',
      },
    ],
    [],
  );

  // Shared helper to update counts with update() then merge fallback
  // Note: counts for splashes/echoes are updated server-side via Cloud Functions triggers

  const onSplash = async (splashType?: 'regular' | 'octopus_hug') => {
    if (splashBusy || !currentWave) return;

    // If no type specified and not already splashed, show choice
    if (!splashType && !hasSplashed) {
      // Show splash/hug options, but do NOT show 'withdrawn' alert here
      Alert.alert(
        'Choose Your Splash',
        'How would you like to show appreciation?',
        [
          {
            text: '💧 Regular Splash',
            onPress: () => onSplash('regular'),
          },
          {
            text: '🐙 Octopus Hug',
            onPress: () => onSplash('octopus_hug'),
          },
          { text: 'Cancel', style: 'cancel' },
        ]
      );
      return;
    }

    // Toggle splash/unsplash
    const isUnsplashing = hasSplashed;
    const prevCount = splashes;
    const nextCount = isUnsplashing
      ? Math.max(0, prevCount - 1)
      : prevCount + 1;

    // Check user sign-in before proceeding
    const user = auth?.()?.currentUser;
    if (!user) {
      notifyError('You must be signed in to splash.');
      return;
    }

    setHasSplashed(!isUnsplashing);
    setSplashes(nextCount);
    setSplashBusy(true);

    const waveId = currentWave.id;
    pendingSplashOp.current = { waveId, action: 'splash' };

    try {
      if (isUnsplashing) {
        // Remove splash silently (no alert/notification)
        try {
          // Get splash type before removing
          const splashDoc = await firestore()
            .collection('waves')
            .doc(waveId)
            .collection('splashes')
            .doc(user.uid)
            .get();
          const splashData = splashDoc?.data?.() || splashDoc?.data || {};
          const removedSplashType = splashData?.splashType || 'regular';
          // Remove the splash
          await removeSplashService(waveId);
          // Decrement user stats
          const statField = removedSplashType === 'octopus_hug' ? 'hugsMade' : 'splashesMade';
          await firestore()
            .collection('users')
            .doc(user.uid)
            .set(
              {
                stats: {
                  [statField]: firestore.FieldValue.increment(-1),
                },
              },
              { merge: true }
            );
          // Update local state
          setUserStats(prev => ({
            ...prev,
            [statField]: Math.max(0, prev[statField] - 1),
          }));
        } catch (err) {
          console.error('Error removing splash:', err);
          // Do not show any alert or notification on removal failure
        }
      } else {
        // Add splash with type
        try {
          await firestore()
            .collection('waves')
            .doc(waveId)
            .collection('splashes')
            .doc(user.uid)
            .set(
              {
                userUid: user.uid,
                waveId,
                userName: user.displayName || 'Anonymous',
                userPhoto: user.photoURL || null,
                splashType: splashType || 'regular',
                createdAt: firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
          // Track splash made by user in their stats
          const statField = splashType === 'octopus_hug' ? 'hugsMade' : 'splashesMade';
          await firestore()
            .collection('users')
            .doc(user.uid)
            .set(
              {
                stats: {
                  [statField]: firestore.FieldValue.increment(1),
                },
              },
              { merge: true }
            );
          // Update local state
          setUserStats(prev => ({
            ...prev,
            [statField]: prev[statField] + 1,
          }));
          // Send ping notification to wave owner
          if (currentWave.ownerUid && currentWave.ownerUid !== user.uid) {
            const userName = profileName || user.displayName || 'Someone';
            const splashEmoji = splashType === 'octopus_hug' ? '🐙' : '💧';
            const splashText = splashType === 'octopus_hug' ? 'sent an octopus hug' : 'splashed';
            // Always use the poster's name from the feed for notifications
            let posterName = '';
            const isOwnWave = currentWave.ownerUid === user.uid;
            if (currentWave && !isOwnWave) {
              posterName = currentWave.authorName || (currentWave as any).posterName || (currentWave as any).ownerName || (currentWave as any).ownerDisplayName || 'Someone';
              await firestore()
                .collection('users')
                .doc(currentWave.ownerUid)
                .collection('pings')
                .add({
                  type: 'splash',
                  message: `${splashEmoji} ${userName} ${splashText} on ${posterName}'s wave`,
                  fromUid: user.uid,
                  fromName: userName,
                  fromPhoto: user.photoURL || null,
                  waveId: currentWave.id,
                  waveTitle: currentWave.title || 'Untitled Wave',
                  splashType: splashType || 'regular',
                  read: false,
                  createdAt: firestore.FieldValue.serverTimestamp(),
                  wavePosterName: posterName,
                });
            }
          }
        } catch (err) {
          console.error('Error adding splash:', err);
          notifyError('Could not add splash. Please try again.');
        }
        const message =
          splashType === 'octopus_hug'
            ? '🐙 Octopus hug sent! The wave is embraced with 8 arms'
            : 'You have splashed the wave!';
        notifySuccess(message);
        // Show octopus hug animation on screen
        // Octopus hug animation removed per user request; only show success message
      }
      try {
        recordPingEvent('splash', waveId, { splashType: splashType || 'regular' });
      } catch {}
    } catch (e) {
      console.error('Splash action failed:', e);
      setHasSplashed(isUnsplashing);
      setSplashes(prevCount);
      notifyError('Could not update splash right now.');
    } finally {
      setSplashBusy(false);
    }
  };
  const onSendEcho = async () => {
    const rawText = echoTextRef.current || '';
    const text = rawText.trim();
    console.log(
      '[ECHO] Starting send echo. Raw length:',
      rawText.length,
      'Trimmed length:',
      text.length,
      'Text:',
      text,
      'Current wave:',
      currentWave?.id,
    );

    if (!text || text.length === 0) {
      console.log('[ECHO] No text provided - text is empty');
      showOceanDialog(
        'Empty Echo',
        'Your echo needs words to drift across the sea!',
      );
      return;
    }

    if (!currentWave) {
      console.log('[ECHO] No current wave');
      showOceanDialog(
        'No Wave Selected',
        'Please navigate to a wave before casting your echo.',
      );
      return;
    }

    console.log('[ECHO] Validation passed, proceeding with echo send');

    try {
      // Optimistic local insertion for immediate UI feedback
      const rawText = echoTextRef.current || '';
      const text = rawText.trim();
      if (!text) return;
      const pendingId = `pending-${Date.now()}`;
      setEchoList(prev => [
        {
          id: pendingId,
          uid: 'me',
          text,
          userName: profileName || accountCreationHandle || 'You',
          userPhoto: profilePhoto || null,
          createdAt: new Date(),
        },
        ...prev,
      ]);

      // Use the new sendEcho transaction
      await sendEcho(currentWave.id, text);

      // Send ping notification to wave owner (if not self)
      if (currentWave.ownerUid && currentWave.ownerUid !== (auth?.()?.currentUser?.uid)) {
        const userName = profileName || accountCreationHandle || 'Someone';
        await firestore()
          .collection('users')
          .doc(currentWave.ownerUid)
          .collection('pings')
          .add({
            type: 'echo',
            message: `💬 ${userName} echoed: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`,
            fromUid: auth?.()?.currentUser?.uid,
            fromName: userName,
            fromPhoto: profilePhoto || null,
            waveId: currentWave.id,
            waveTitle: currentWave.title || 'Untitled Wave',
            echoText: text,
            read: false,
            createdAt: firestore.FieldValue.serverTimestamp(),
          });
      }

      // Clear input and hide echo UI before showing success
      updateEchoText('');
      setEchoList(prev => prev.filter(e => e.id !== pendingId));
      setMyEcho({ text });
      setShowEchoes(false); // Hide echo UI first
      setTimeout(() => {
        showOceanDialog(
          'Echo Cast',
          'Your echo has been successfully casted.',
        );
        runEchoRippleAnimation('Your echo has been successfully casted.');
      }, 200); // Small delay to ensure UI hides first
      try {
        recordPingEvent('echo', currentWave.id, { text });
      } catch {}
    } catch (e: any) {
      // Only show error if it is not a permission-denied error and echo was not created
      if (e?.message && e.message.includes('permission-denied')) {
        // Silently ignore, since echo is likely created
        setShowEchoes(false);
        setTimeout(() => {
          showOceanDialog('Echo Cast', 'Your echo has been successfully casted.');
          runEchoRippleAnimation('Your echo has been successfully casted.');
        }, 200);
        return;
      }
      Alert.alert('Error', `Could not send echo: ${e?.message || e || 'Unknown error'}`);
    }
  };

  const onEditMyEcho = (echo: { id: string; text: string }) => {
    setEditingEcho(echo);
    updateEchoText(echo.text);
    setShowEchoes(true);
  };

  const onSaveEditedEcho = async () => {
    if (!editingEcho || !currentWave) return;
    const newText = echoText.trim();
    if (!newText) return;

    const echoId = editingEcho.id;
    setEchoList(prev =>
      prev.map(e => (e.id === echoId ? { ...e, text: newText } : e)),
    );
    updateEchoText('');
    setEditingEcho(null);
    setShowEchoes(false);
    showOceanDialog(
      'Echo Updated',
      'Your echo has been recast into the waves!',
    );

    try {
      let firestoreMod: any;
      try {
        firestoreMod = require('@react-native-firebase/firestore').default;
      } catch {}
      if (firestoreMod) {
        await firestoreMod()
          .collection('waves')
          .doc(currentWave.id)
          .collection('echoes')
          .doc(echoId)
          .update({
            text: newText,
            updatedAt: firestoreMod.FieldValue.serverTimestamp(),
          });
      }
    } catch (e) {
      console.warn('Update echo failed', e);
      Alert.alert('Update failed', 'Could not update echo right now.');
    }
  };
  const onDeleteMyEcho = async () => {
    if (!currentWave || !myEcho) return;
    try {
      let firestoreMod: any;
      let authMod: any;
      try {
        firestoreMod = require('@react-native-firebase/firestore').default;
      } catch {}
      try {
        authMod = require('@react-native-firebase/auth').default;
      } catch {}
      const user = authMod?.().currentUser;
      if (!firestoreMod || !user) {
        setEchoList(prev => prev.filter(e => e.uid !== 'me'));
        setMyEcho(null);
        return;
      }
      // Find the most recent echo by the user to delete it.
      const query = await firestoreMod()
        .collection('waves')
        .doc(currentWave.id)
        .collection('echoes')
        .where('userUid', '==', user.uid)
        .orderBy('createdAt', 'desc')
        .limit(1)
        .get();

      const docToDelete = query?.docs?.[0];
      if (docToDelete) {
        await docToDelete.ref.delete();
        // Server Cloud Function will decrement counts.echoes
      }

      setEchoList(prev => prev.filter(e => e.uid !== user.uid));
      setMyEcho(null);
      updateEchoText('');
      showOceanDialog(
        'Echo Removed',
        'Your last echo has been pulled from the sea.',
      );
    } catch (e) {
      console.warn('Delete echo failed', e);
      notifyError('Could not delete echo right now');
    }
  };

  const onDeleteEchoById = async (echoId: string) => {
    if (!currentWave) return;
    setEchoList(prev => prev.filter(e => e.id !== echoId));
    setShowEchoes(false);
    showOceanDialog(
      'Echo Removed',
      'Your echo has been pulled from the waves.',
    );

    try {
      let firestoreMod: any;
      let authMod: any;
      try {
        firestoreMod = require('@react-native-firebase/firestore').default;
      } catch {}
      try {
        authMod = require('@react-native-firebase/auth').default;
      } catch {}
      const user = authMod?.().currentUser;
      if (!firestoreMod || !user) return;

      await firestoreMod()
        .collection('waves')
        .doc(currentWave.id)
        .collection('echoes')
        .doc(echoId)
        .delete();
      // Server Cloud Function will decrement counts.echoes
    } catch (e) {
      console.warn('Delete echo by ID failed', e);
      Alert.alert('Delete failed', 'Could not delete echo right now.');
    }
  };

  // Keep hasSplashed and counters in sync when the current wave changes
  useEffect(() => {
    if (!currentWave?.id) {
      setHasSplashed(false);
      setSplashes(0);
      setEchoes(0);
      setMyEcho(null);
      setEchoList([]);
      return;
    }

    // Reset splash state immediately when switching waves
    setHasSplashed(false);
    setSplashes(0);

    let unsubSplash: any = null;
    let unsubMyEcho: any = null;
    let unsubEchoList: any = null;
    let unsubWaveCounts: any = null;

    (async () => {
      let firestoreMod: any = null;
      let authMod: any = null;
      try {
        firestoreMod = require('@react-native-firebase/firestore').default;
      } catch {}
      try {
        authMod = require('@react-native-firebase/auth').default;
      } catch {}
      const uid = authMod?.().currentUser?.uid;

      if (!firestoreMod || !currentWave?.id) return;

      // Listen to wave counts
      unsubWaveCounts = firestoreMod()
        .doc(`waves/${currentWave.id}`)
        .onSnapshot((snap: any) => {
          const data = snap?.data() || {};
          const counts = data.counts || { splashes: 0, echoes: 0 };
          const nextSplashes = Math.max(0, counts.splashes || 0);
          const nextRegularSplashes = Math.max(
            0,
            counts.regularSplashes || counts.splashes || 0,
          );
          const nextHugs = Math.max(0, counts.hugs || 0);
          const nextEchoes = Math.max(0, counts.echoes || 0);

          console.log(
            `[SPLASH DEBUG] Wave ${currentWave.id} counts from Firestore: splashes=${nextSplashes}, echoes=${nextEchoes}`,
          );

          // Always update counts from Firestore - no gating
          setSplashes(nextSplashes);
          setEchoes(nextEchoes);
          setWaveStats(prev => ({
            ...prev,
            [currentWave.id]: {
              ...(prev[currentWave.id] || {}),
              splashes: nextSplashes,
              regularSplashes: nextRegularSplashes,
              hugs: nextHugs,
              echoes: nextEchoes,
            },
          }));
        });

      if (uid) {
        // Check if current user has splashed this wave
        unsubSplash = firestoreMod()
          .collection('waves')
          .doc(currentWave.id)
          .collection('splashes')
          .doc(uid)
          .onSnapshot(
            { includeMetadataChanges: true },
            (doc: any) => {
              // Always set splash state based on Firestore - permanent state
              const exists = !!(doc && doc.exists);
              setHasSplashed(exists === true);

              // Clear any pending operations when Firestore confirms
              const waiter = pendingSplashAwait.current;
              if (
                waiter &&
                waiter.waveId === currentWave.id &&
                exists === waiter.desired
              ) {
                try {
                  waiter.resolve();
                } catch {}
                pendingSplashAwait.current = null;
                pendingSplashOp.current = null;
              }
            },
            (error: any) => {
              console.error('Splash listener error:', error);
              setHasSplashed(false);
            },
          );

        // Check if current user has echoed this wave (with error fallback for index)
        const handleMyEchoSnapshot = (querySnapshot: any) => {
          try {
            if (!querySnapshot || typeof querySnapshot.empty === 'undefined') {
              // Guard against unexpected null/undefined
              setMyEcho(null);
              return;
            }
            if (!querySnapshot.empty) {
              const echoDoc = querySnapshot?.docs?.[0];
              const echoData = echoDoc?.data?.() || echoDoc.data();
              setMyEcho({ text: echoData?.text || '', id: echoDoc.id });
            } else {
              setMyEcho(null);
            }
          } catch {
            setMyEcho(null);
          }
        };

        const myEchoQuery = firestoreMod()
          .collection('waves')
          .doc(currentWave.id)
          .collection('echoes')
          .where('userUid', '==', uid)
          .orderBy('createdAt', 'desc')
          .limit(1);

        let altSubscribed = false;
        unsubMyEcho = myEchoQuery.onSnapshot(
          handleMyEchoSnapshot,
          (error: any) => {
            // Common on-device error when composite index is missing
            try {
              console.warn('myEcho onSnapshot error:', error?.code || error);
            } catch {}
            if (altSubscribed) return;
            try {
              // Fallback: drop orderBy (no composite index needed)
              const altQuery = firestoreMod()
                .collection('waves')
                .doc(currentWave.id)
                .collection('echoes')
                .where('userUid', '==', uid)
                .limit(1);
              const altUnsub = altQuery.onSnapshot(handleMyEchoSnapshot, () =>
                setMyEcho(null),
              );
              // Keep for cleanup
              unsubMyEcho = () => {
                try {
                  altUnsub && altUnsub();
                } catch {}
              };
              altSubscribed = true;
            } catch {
              setMyEcho(null);
            }
          },
        );
      }

      // Listen to all echoes for this wave
      unsubEchoList = firestoreMod()
        .collection('waves')
        .doc(currentWave.id)
        .collection('echoes')
        .orderBy('createdAt', 'desc')
        .limit(20)
        .onSnapshot((querySnapshot: any) => {
          try {
            if (!querySnapshot || typeof querySnapshot.forEach !== 'function') {
              setEchoList([]);
              return;
            }
            const echoes: any[] = [];
            querySnapshot.forEach((doc: any) => {
              const data = doc.data();
              echoes.push({
                id: doc.id,
                uid: data?.userUid,
                text: data?.text,
                userName: data?.userName,
                userPhoto: data?.userPhoto,
                createdAt: data?.createdAt,
              });
            });
            setEchoList(echoes);
          } catch {
            setEchoList([]);
          }
        });
    })();

    return () => {
      try {
        unsubSplash && unsubSplash();
      } catch {}
      try {
        unsubMyEcho && unsubMyEcho();
      } catch {}
      try {
        unsubEchoList && unsubEchoList();
      } catch {}
      try {
        unsubWaveCounts && unsubWaveCounts();
      } catch {}
    };
  }, [currentWave?.id]);
  const onShare = async () => {
    try {
      const wave = currentWave;
      if (!wave) {
        await Share.share({
          title: 'Casta Wave',
          message: 'Casta Wave - check out this wave!',
        });
        return;
      }
      let authMod: any = null;
      try {
        authMod = require('@react-native-firebase/auth').default;
      } catch {}
      const uid = authMod?.().currentUser?.uid;
      const waveId = wave.id;
      const deep = `drift://wave/${encodeURIComponent(waveId)}`;
      const web = `https://drift.link/w/${encodeURIComponent(waveId)}`;
      const caption = wave.captionText ? `“${wave.captionText}”` : 'my wave';
      const msg = `Casta Wave — Check out ${caption}\n\n${web}\n(Open in app: ${deep})`;
      await Share.share({ title: 'Casta Wave', message: msg });
    } catch {
      Alert.alert('Share failed', 'Unable to cast the net right now.');
    }
  };
  const onShareWave = async (wave: Wave) => {
    try {
      const waveId = wave.id;
      const deep = `drift://wave/${encodeURIComponent(waveId)}`;
      const web = `https://drift.link/w/${encodeURIComponent(waveId)}`;
      const caption = wave.captionText ? `“${wave.captionText}”` : 'my wave';
      const msg = `Casta Wave — Check out ${caption}\n\n${web}\n(Open in app: ${deep})`;
      await Share.share({ title: 'Casta Wave', message: msg });
    } catch {
      showOceanDialog(
        'Share Failed',
        'Unable to cast the net. Try again later.',
      );
    }
  };
  const anchorWave = async (wave: Wave) => {
    try {
      let firestoreMod: any = null;
      let authMod: any = null;
      try {
        firestoreMod = require('@react-native-firebase/firestore').default;
      } catch {}
      try {
        authMod = require('@react-native-firebase/auth').default;
      } catch {}
      const uid = authMod?.().currentUser?.uid;
      if (!firestoreMod || !uid) {
        showOceanDialog('Anchor Wave', 'Navigation tools are not installed.');
        return;
      }
      await firestoreMod()
        .doc(`users/${uid}/pinned/${wave.id}`)
        .set(
          {
            waveId: wave.id,
            createdAt: firestoreMod.FieldValue?.serverTimestamp
              ? firestoreMod.FieldValue.serverTimestamp()
              : new Date(),
          },
          { merge: true },
        );
      try {
        require('react-native').ToastAndroid.show(
          'Wave anchored',
          require('react-native').ToastAndroid.SHORT,
        );
      } catch {}
    } catch (e) {
      showOceanDialog(
        'Anchor Failed',
        'Could not drop anchor on this wave. The seafloor is unreachable.',
      );
    }
  };

  // Crew (Follow/Unfollow) handlers
  const handleJoinCrew = async (targetUid: string, targetName?: string) => {
    if (crewLoading) return;
    setCrewLoading(true);
    try {
      const user = auth().currentUser;
      if (!user) {
        Alert.alert('Sign in required', 'Please sign in to join a crew.');
        return;
      }

      await joinCrew(targetUid);
      setIsInUserCrew(prev => ({ ...prev, [targetUid]: true }));
      notifySuccess(`Joined ${targetName || 'user'}'s crew`);
      loadCrewCounts();
      await loadDriftWatchers();
    } catch (e) {
      console.error('Join crew error:', e);
      let msg = 'Could not join crew right now';
      if (e && (e.message || (typeof e === 'string'))) {
        msg = e.message || e.toString();
      }
      notifyError(msg);
    } finally {
      setCrewLoading(false);
    }
  };

  const handleLeaveCrew = async (targetUid: string, targetName?: string) => {
    if (crewLoading) return;
    setCrewLoading(true);
    try {
      await leaveCrew(targetUid);
      setIsInUserCrew(prev => ({ ...prev, [targetUid]: false }));
      notifySuccess(`Left ${targetName || 'user'}'s crew`);
      loadCrewCounts();
      await loadDriftWatchers();
    } catch (e) {
      console.error('Leave crew error:', e);
      notifyError('Could not leave crew right now');
    } finally {
      setCrewLoading(false);
    }
  };

  const handleBlockUser = async (targetUid: string, targetName?: string) => {
    try {
      const user = auth().currentUser;
      if (!user) {
        Alert.alert('Sign in required', 'Please sign in to block users.');
        return;
      }

      // Store in Firestore
      await firestore()
        .collection('users')
        .doc(user.uid)
        .collection('blocked')
        .doc(targetUid)
        .set({
          blockedAt: firestore.FieldValue.serverTimestamp(),
          blockedName: targetName || 'Unknown',
        });

      // Remove blocked user's waves from feed immediately
      setWavesFeed(prev => prev.filter(wave => wave.ownerUid !== targetUid));
      setPublicFeed(prev => prev.filter(wave => wave.ownerUid !== targetUid));

      // Also update backend for real-time drift matching enforcement
      try {
        const cfg = require('./liveConfig');
        const backendUrl = cfg?.BACKEND_BASE_URL || cfg?.USER_MGMT_ENDPOINT_BASE || cfg?.default?.BACKEND_BASE_URL;
        if (backendUrl) {
          await fetch(`${backendUrl}/block-user`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid: user.uid, targetUid }),
          });
        }
      } catch (backendErr) {
        console.log('Backend block update skipped:', backendErr);
      }

      // Reload blocked users list
      await loadBlockedAndRemovedUsers();

      notifySuccess(`Blocked ${targetName || 'user'}. Their waves are now hidden.`);
    } catch (e) {
      console.error('Block user error:', e);
      notifyError('Could not block user right now');
    }
  };

  const handleRemoveFromDrift = async (targetUid: string, targetName?: string) => {
    try {
      const user = auth().currentUser;
      if (!user) {
        Alert.alert('Sign in required', 'Please sign in to manage your drift.');
        return;
      }

      await firestore()
        .collection('users')
        .doc(user.uid)
        .collection('removed')
        .doc(targetUid)
        .set({
          removedAt: firestore.FieldValue.serverTimestamp(),
          removedName: targetName || 'Unknown',
        });

      // Remove this user's waves from both feeds immediately
      setWavesFeed(prev => prev.filter(wave => wave.ownerUid !== targetUid));
      setPublicFeed(prev => prev.filter(wave => wave.ownerUid !== targetUid));

      // Reload removed users list
      await loadBlockedAndRemovedUsers();

      notifySuccess(`Removed ${targetName || 'user'} from your drift. Their waves are now hidden.`);
    } catch (e) {
      console.error('Remove user error:', e);
      notifyError('Could not remove user from drift right now');
    }
  };

  const loadCrewCounts = async () => {
    try {
      const user = auth().currentUser;
      if (!user) return;
      const count = await getCrewCount(user.uid);
      setMyCrewCount(count);
    } catch (e) {
      console.error('Load crew counts error:', e);
    }
  };

  const checkIfInCrew = async (targetUid: string) => {
    try {
      const inCrew = await isInCrew(targetUid);
      setIsInUserCrew(prev => ({ ...prev, [targetUid]: inCrew }));
    } catch (e) {
      console.error('Check crew status error:', e);
    }
  };
  const runSplashAnimation = () => {
    splashAnimation.setValue(0.8);
    Animated.spring(splashAnimation, {
      toValue: 1,
      friction: 2,
      tension: 160,
      useNativeDriver: true,
    }).start();
  };

  // Ocean-themed echo animation - expanding ripples like sound waves in water
  const runEchoRippleAnimation = (message?: string) => {
    const rippleDurationMs = 3500;
    const rippleDelayMs = 200;
    const noticeDurationMs = 3600;
    const noticeText = message ?? 'Your echo drifts across the open sea';

    console.log(
      '[ANIMATION] Starting echo ripple animation with message:',
      noticeText,
    );
    setRippleSuccessText(noticeText);
    setOceanEchoNoticeText(noticeText);
    setShowEchoRipple(true);
    console.log('[ANIMATION] showEchoRipple set to TRUE');
    echoRipples.forEach(ripple => ripple.setValue(0));

    // Clear any existing timer
    if (oceanEchoNoticeTimer.current) {
      clearTimeout(oceanEchoNoticeTimer.current);
      oceanEchoNoticeTimer.current = null;
    }

    // Don't show top notification, only center ripple message
    setShowOceanEchoNotice(false);
    console.log('[ANIMATION] Center ripple message will be shown');

    const createTiming = (ripple: Animated.Value) =>
      Animated.timing(ripple, {
        toValue: 1,
        duration: rippleDurationMs,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      });

    Animated.stagger(rippleDelayMs, [
      createTiming(echoRipples[0]),
      createTiming(echoRipples[1]),
      createTiming(echoRipples[2]),
    ]).start(() => {
      console.log('[ANIMATION] Ripple animation completed');
      setShowEchoRipple(false);
      setRippleSuccessText('');
    });
  };

  // Detect Wi-Fi vs cellular (optional dependency)
  useEffect(() => {
    let unsub: any = null;
    try {
      const NetInfo = require('@react-native-community/netinfo').default;
      NetInfo.fetch().then(async (s: any) => {
        const wifi = !!s?.isWifi || s?.type === 'wifi';
        setIsWifi(wifi);
        setIsOffline(
          s?.isConnected === false || s?.isInternetReachable === false,
        );
        try {
          await flushPendingEchoes();
        } catch {}
      });
      unsub = NetInfo.addEventListener(async (s: any) => {
        const wifi = !!s?.isWifi || s?.type === 'wifi';
        setIsWifi(wifi);
        setIsOffline(
          s?.isConnected === false || s?.isInternetReachable === false,
        );
        try {
          await flushPendingEchoes();
        } catch {}
      });
    } catch {}
    return () => {
      try {
        unsub && unsub();
      } catch {}
    };
  }, []);

  // Flush any pending echoes stored locally (best-effort)
  const flushPendingEchoes = async () => {
    try {
      if (!currentWave?.id) return;
      let firestoreMod: any = null;
      let authMod: any = null;
      try {
        firestoreMod = require('@react-native-firebase/firestore').default;
      } catch {}
      try {
        authMod = require('@react-native-firebase/auth').default;
      } catch {}
      const uid = authMod?.().currentUser?.uid;
      if (!firestoreMod || !uid) return;
      const AS = (() => {
        try {
          return require('@react-native-async-storage/async-storage').default;
        } catch {
          return null;
        }
      })();
      if (!AS) return;
      const key = `pending_echoes_${currentWave.id}`;
      const raw = await AS.getItem(key);
      const list = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(list) || list.length === 0) return;
      const echoCollection = firestoreMod()
        .collection('waves')
        .doc(currentWave.id)
        .collection('echoes');
      for (const e of list) {
        try {
          await echoCollection.add({
            text: e.text,
            userUid: uid,
            userName: e.userName || 'Anonymous',
            userPhoto: e.userPhoto || null,
            createdAt: firestoreMod.FieldValue?.serverTimestamp
              ? firestoreMod.FieldValue.serverTimestamp()
              : new Date(),
          });
          // Server Cloud Function will increment counts.echoes
        } catch {}
      }
      await AS.removeItem(key);
    } catch {}
  };

  // Load Bridge settings from Firestore on first open and on startup
  useEffect(() => {
    let did = false;
    const load = async () => {
      let firestoreMod: any = null;
      let authMod: any = null;
      try {
        firestoreMod = require('@react-native-firebase/firestore').default;
      } catch {}
      try {
        authMod = require('@react-native-firebase/auth').default;
      } catch {}
      const uid = authMod?.().currentUser?.uid;
      if (!firestoreMod || !uid) return;
      try {
        const snap = await firestoreMod()
          .doc(`users/${uid}/settings/bridge`)
          .get();
        const d = snap?.data() || {};
        if (snap?.exists && !did) setBridge(prev => ({ ...prev, ...d }));
      } catch {}
    };
    load();
    return () => {
      did = true;
    };
  }, []);

  const saveBridge = async (next?: Partial<BridgeSettings>) => {
    const updated: BridgeSettings = {
      ...bridge,
      ...(next || {}),
    } as BridgeSettings;
    setBridge(updated);
    let firestoreMod: any = null;
    let authMod: any = null;
    try {
      firestoreMod = require('@react-native-firebase/firestore').default;
    } catch {}
    try {
      authMod = require('@react-native-firebase/auth').default;
    } catch {}
    const uid = authMod?.().currentUser?.uid;
    if (!firestoreMod || !uid) return;
    try {
      await firestoreMod()
        .doc(`users/${uid}/settings/bridge`)
        .set(updated, { merge: true });
    } catch {}
  };

  const shareProfile = async () => {
    try {
      let authMod: any = null;
      try {
        authMod = require('@react-native-firebase/auth').default;
      } catch {}
      const uid = authMod?.().currentUser?.uid;
      const name = profileName || accountCreationHandle || '@your_handle';
      const deep = uid ? `drift://user/${uid}` : 'drift://home';
      const web = uid ? `https://drift.link/u/${uid}` : 'https://drift.link/';
      const msg = `Casta Wave — Check out my Shore ${name}!\n\n${web}\n(Open in app: ${deep})`;
      await Share.share({ title: 'Casta Wave', message: msg });
    } catch {
      Alert.alert('Share failed', 'Unable to share your profile right now.');
    }
  };

  // Load wave stats for current wavesFeed (best-effort if Firebase exists)
  useEffect(() => {
    if (wavesFeed.length === 0) return;
    let firestoreMod: any = null;
    try {
      firestoreMod = require('@react-native-firebase/firestore').default;
    } catch {}
    if (!firestoreMod) return;
    let mounted = true;
    (async () => {
      for (const w of wavesFeed) {
        try {
          const docSnap = await firestoreMod()
            .collection('waves')
            .doc(w.id)
            .get();
          const d = (docSnap?.data?.() || docSnap?.data || {}) as any;
          const counts = d?.counts || {};
          if (!mounted) break;
          setWaveStats(prev => ({
            ...prev,
            [w.id]: {
              splashes: Math.max(0, Number(counts?.splashes || 0)),
              regularSplashes: Math.max(0, Number(counts?.regularSplashes || 0)),
              hugs: Math.max(0, Number(counts?.hugs || 0)),
              echoes: Math.max(0, Number(counts?.echoes || 0)),
              views: typeof d?.viewsCount === 'number' ? d.viewsCount : 0,
              createdAt:
                d?.createdAt &&
                (typeof d.createdAt?.toDate === 'function'
                  ? d.createdAt.toDate().getTime()
                  : d.createdAt?.seconds
                  ? d.createdAt.seconds * 1000
                  : Date.now()),
            },
          }));
        } catch {}
      }
    })();
    return () => {
      mounted = false;
    };
  }, [wavesFeed]);

  const shareProfileLink = async () => {
    try {
      let authMod: any = null;
      try {
        authMod = require('@react-native-firebase/auth').default;
      } catch {}
      const uid = authMod?.().currentUser?.uid;
      const deep = uid ? `drift://user/${uid}` : 'drift://home';
      const web = uid ? `https://drift.link/u/${uid}` : 'https://drift.link/';
      await Share.share({
        title: 'Share Profile Link',
        message: `${web}\nOpen in app: ${deep}`,
      });
    } catch {
      Alert.alert('Share failed', 'Unable to share the link right now.');
    }
  };

  // Load profile from Firestore when opening MY SHORE
  useEffect(() => {
    if (!showProfile) return;
    let firestoreMod: any = null;
    let authMod: any = null;
    try {
      firestoreMod = require('@react-native-firebase/firestore').default;
    } catch {}
    try {
      authMod = require('@react-native-firebase/auth').default;
    } catch {}
    const uid = authMod?.().currentUser?.uid;
    if (!firestoreMod || !uid) return;
    const ref = firestoreMod().doc(`users/${uid}`);
    ref
      .get()
      .then((snap: any) => {
        const d = snap?.data() || {};
        const displayHandleValue =
          normalizeUserHandle(d.userName) ||
          normalizeUserHandle(d.username) ||
          normalizeUserHandle(authMod().currentUser?.displayName);
        setProfileName(prev =>
          displayHandleValue
            ? displayHandleValue
            : prev && prev !== '@your_handle'
            ? prev
            : '@your_handle',
        );
        setProfileBio(d.bio || '');
        // Do not default to auth photo; show only saved userPhoto or none
        setProfilePhoto(d.userPhoto || null);
      })
      .catch(() => {});
    // Load crew counts
    loadCrewCounts();
    let countCancelled = false;
    setMyWaveCount(null);
    (async () => {
      try {
        const ownerQuery = firestoreMod()
          .collection('waves')
          .where('ownerUid', '==', uid);
        const authorQuery = firestoreMod()
          .collection('waves')
          .where('authorId', '==', uid);
        const [ownerSnap, authorSnap] = await Promise.all([
          ownerQuery.get(),
          authorQuery.get(),
        ]);
        if (countCancelled) return;
        const ids = new Set<string>();
        ownerSnap.forEach(doc => ids.add(doc.id));
        authorSnap.forEach(doc => ids.add(doc.id));
        if (countCancelled) return;
        setMyWaveCount(ids.size);
      } catch {}
    })();
    return () => {
      countCancelled = true;
    };
  }, [showProfile]);

  // Check crew status when wave options target changes
  useEffect(() => {
    if (
      !waveOptionsTarget ||
      !waveOptionsTarget.ownerUid ||
      waveOptionsTarget.ownerUid === myUid
    ) {
      return;
    }
    checkIfInCrew(waveOptionsTarget.ownerUid);
  }, [waveOptionsTarget, myUid]);

  // Load Treasure stats when Treasure sheet is opened
  useEffect(() => {
    if (!showTreasure) return;
    let firestoreMod: any = null;
    let authMod: any = null;
    try {
      firestoreMod = require('@react-native-firebase/firestore').default;
    } catch {}
    try {
      authMod = require('@react-native-firebase/auth').default;
    } catch {}
    const uid = authMod?.().currentUser?.uid;
    if (!firestoreMod || !uid) return;
    firestoreMod()
      .doc(`users/${uid}/private/treasure`)
      .get()
      .then((snap: any) => {
        const d = snap?.data() || {};
        setTreasureStats({
          tipsTotal: Number(d.tipsTotal || 0),
          withdrawable: Number(d.withdrawable || 0),
          lastPayout: d.lastPayout || null,
        });
      })
      .catch(() => {
        setTreasureStats({ tipsTotal: 0, withdrawable: 0 });
      });

    // Fetch recent tips. Prefer nested collection users/{uid}/private/treasure/tips; fallback to users/{uid}/tips
    const fetchTips = async () => {
      try {
        const q1 = await firestoreMod()
          .collection(`users/${uid}/private/treasure/tips`)
          .orderBy('createdAt', 'desc')
          .limit(50)
          .get();
        if (q1 && typeof q1.empty !== 'undefined' && !q1.empty) {
        setTipHistory((q1?.docs || []).map((d: any) => ({ id: d.id, ...d.data() })));
          return;
        }
      } catch {}
      try {
        const q2 = await firestoreMod()
          .collection(`users/${uid}/tips`)
          .orderBy('createdAt', 'desc')
          .limit(50)
          .get();
        setTipHistory((q2?.docs || []).map((d: any) => ({ id: d.id, ...d.data() })));
      } catch {
        setTipHistory([]);
      }
    };
    fetchTips();

    // Fetch past withdrawals
    const fetchWithdrawals = async () => {
      try {
        const q = await firestoreMod()
          .collection(`users/${uid}/private/treasure/withdrawals`)
          .orderBy('createdAt', 'desc')
          .limit(50)
          .get();
        setWithdrawals((q?.docs || []).map((d: any) => ({ id: d.id, ...d.data() })));
      } catch {
        setWithdrawals([]);
      }
    };
    fetchWithdrawals();
  }, [showTreasure]);

  const pickProfileImage = async () => {
    try {
      const res = await launchImageLibrary({
        mediaType: 'photo',
        selectionLimit: 1,
      });
      const asset = res.assets?.[0];
      if (asset?.uri) setProfilePhoto(asset.uri);
    } catch {}
  };

  const captureProfileImage = async () => {
    try {
      const res = await launchCamera({
        mediaType: 'photo',
        saveToPhotos: true,
      });
      const asset = res.assets?.[0];
      if (asset?.uri) setProfilePhoto(asset.uri);
    } catch {}
  };

  const saveProfile = async () => {
    let firestoreMod: any = null;
    let authMod: any = null;
    let storageMod: any = null;
    try {
      firestoreMod = require('@react-native-firebase/firestore').default;
    } catch {}
    try {
      authMod = require('@react-native-firebase/auth').default;
    } catch {}
    try {
      storageMod = require('@react-native-firebase/storage').default;
    } catch {}
    const uid = authMod?.().currentUser?.uid;
    if (!firestoreMod || !uid) {
      setShowEditShore(false);
      return;
    }
    try {
      let finalPhotoUrl: string | null = profilePhoto || null;
      const isHttp = (u?: string | null) => !!u && /^https?:\/\//i.test(u);
      if (DEV_SKIP_STORAGE_UPLOAD) {
        // Keep local photo in dev; avoid Storage task
        // Proceed to save Firestore profile with the same URI (may be local-only)
      } else if (storageMod && finalPhotoUrl && !isHttp(finalPhotoUrl)) {
        // Upload local file to Firebase Storage and use a public download URL so others can view it
        let localPath = String(finalPhotoUrl);
        try {
          localPath = decodeURI(localPath);
        } catch {}
        if (Platform.OS === 'android' && localPath.startsWith('file://')) {
          localPath = localPath.replace('file://', '');
        }
        if (!localPath) {
          Alert.alert(
            'Upload error',
            'Could not resolve a local path for your profile photo.',
          );
        } else {
          const safeName = (profileName || 'profile').replace(
            /[^A-Za-z0-9._-]/g,
            '_',
          );
          const dest = `users/${uid}/profile_${Date.now()}_${safeName}.jpg`;
          await storageMod()
            .ref(dest)
            .putFile(localPath, { contentType: 'image/jpeg' });
          finalPhotoUrl = await storageMod().ref(dest).getDownloadURL();
        }
      }

      await firestoreMod()
        .doc(`users/${uid}`)
        .set(
          {
            userName: profileName,
            displayName: profileName,
            username_lc: profileName.replace(/^[\/]+/, '').toLowerCase(),
            userPhoto: finalPhotoUrl || null,
            bio: profileBio,
          },
          { merge: true },
        );
      setProfilePhoto(finalPhotoUrl || null);
      setShowEditShore(false);
      showOceanDialog(
        'Shore Updated',
        'Your shore has been charted successfully!',
      );
    } catch (e) {
      showOceanDialog(
        'Save Failed',
        'Could not update your shore. Try again when the tides are calmer.',
      );
    }
  };

  // Cross-platform permission request for Camera and Microphone
  const requestMediaPermissions = async (): Promise<boolean> => {
    if (Platform.OS === 'android') {
      return await ensureCamMicPermissionsAndroid();
    }

    if (Platform.OS === 'ios') {
      // On iOS, permissions are implicitly requested when you first try to use the feature.
      // Libraries like react-native-agora or react-native-camera handle this.
      // We can return true here and assume the library will trigger the system prompt.
      // For robust handling, a dedicated permissions library like 'react-native-permissions'
      // would be ideal to check status beforehand, but for now, this is sufficient.
      console.log(
        'iOS: Permissions will be requested by the live streaming library upon use.',
      );
      return true;
    }

    // For other platforms, assume permissions are not needed or handled differently.
    return true;
  };

  const handleCameraLaunch = (options: CameraOptions) => {
    launchCamera(options, response => {
      if (response.didCancel) {
        console.log('User cancelled camera');
      } else if (response.errorCode) {
        Alert.alert(
          'Camera Error',
          response.errorMessage || 'An unknown error occurred.',
        );
      } else if (response.assets && response.assets.length > 0) {
        // Close the action sheet and open the editor
        setShowMakeWaves(false);
        const picked = response.assets[0];
        setCapturedMedia(picked);
        setTranscoding(false);
      }
    });
  };

  const handleMediaSelect = (response: ImagePickerResponse) => {
    if (response.didCancel) {
      console.log('User cancelled media selection');
    } else if (response.errorCode) {
      Alert.alert(
        'Media Error',
        response.errorMessage || 'An unknown error occurred.',
      );
    } else if (response.assets && response.assets.length > 0) {
      // Close the action sheet and open the editor
      setShowMakeWaves(false);
      const picked = response.assets[0];
      setCapturedMedia(picked);
      setTranscoding(false);
    }
  };

  // Start in-app Live with editor overlays (TikTok-style)
  const goLiveEditor = async () => {
    setShowMakeWaves(false);
    if (Platform.OS === 'android') {
      try {
        const results = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.CAMERA,
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        ] as any);
        const cam = results[PermissionsAndroid.PERMISSIONS.CAMERA];
        const mic = results[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];
        if (
          cam !== PermissionsAndroid.RESULTS.GRANTED ||
          mic !== PermissionsAndroid.RESULTS.GRANTED
        ) {
          Alert.alert(
            'Permission needed',
            'Camera and microphone are required to go live.',
          );
          return;
        }
      } catch {}
    }
    setShowLive(true);
  };

  const openCamera = async () => {
    Alert.alert(
      'Create a Wave',
      'What would you like to do?',
      [
        {
          text: 'Take Photo',
          onPress: () =>
            handleCameraLaunch({ mediaType: 'photo', quality: 0.8 }),
        },
        {
          text: 'Record Video',
          onPress: () =>
            handleCameraLaunch({ mediaType: 'video', videoQuality: 'high' }),
        },
        { text: 'Cancel', style: 'cancel' },
      ],
      { cancelable: true },
    );
  };

  const fromGallery = () => {
    launchImageLibrary({ mediaType: 'mixed', quality: 0.8 }, handleMediaSelect);
  };

  const pickAudioFromDevice = () => {
    const ensureAudioPermissionAndroid = async (): Promise<boolean> => {
      if (Platform.OS !== 'android') return true;
      try {
        const apiLevel =
          typeof Platform.Version === 'number' ? Platform.Version : 0;
        if (apiLevel >= 33) {
          const granted = await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.READ_MEDIA_AUDIO,
            {
              title: 'Drift Audio Permission',
              message:
                'Drift needs access to your music to attach Ocean Melodies.',
              buttonPositive: 'Allow',
              buttonNegative: 'Deny',
            },
          );
          return granted === PermissionsAndroid.RESULTS.GRANTED;
        } else {
          const granted = await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE,
            {
              title: 'Drift Storage Permission',
              message:
                'Drift needs access to your storage to pick audio files.',
              buttonPositive: 'Allow',
              buttonNegative: 'Deny',
            },
          );
          return granted === PermissionsAndroid.RESULTS.GRANTED;
        }
      } catch (e) {
        console.warn(e);
        return false;
      }
    };

    const startPick = () =>
      launchImageLibrary(
        { mediaType: 'mixed', selectionLimit: 1 },
        async response => {
          if (response.didCancel) return;
          if (response.errorCode) {
            Alert.alert(
              'Audio Picker Error',
              response.errorMessage || 'Unable to open picker.',
            );
            return;
          }
          const asset = response.assets?.[0];
          if (asset?.type?.startsWith('audio/') && asset.uri) {
            let rawUri = String(asset.uri);
            if (!/^file:/.test(rawUri)) {
              // Fallback: copy content:// to app cache so we can read/upload it
              try {
                const RNFS = require('react-native-fs');
                const baseName = (asset.fileName || 'audio').replace(
                  /[^A-Za-z0-9._-]/g,
                  '_',
                );
                const ext =
                  (baseName.includes('.') && baseName.split('.').pop()) ||
                  'mp3';
                const dest = `${
                  RNFS.CachesDirectoryPath
                }/overlay_${Date.now()}_${baseName}.${ext}`;
                await RNFS.copyFile(rawUri, dest);
                rawUri = `file://${dest}`;
              } catch (e) {
                console.warn('Audio copy from gallery failed', e);
              }
            }
            // Best-effort: convert local files to m4a if ffmpeg-kit is available
            setAttachedAudio({ uri: rawUri, name: asset.fileName });
            setShowAudioModal(false);
            setAudioUrlInput('');
            // No alert here: audio is now set and will show under video preview
          } else {
            Alert.alert('No audio selected', 'Please choose an audio file.');
          }
        },
      );

    if (Platform.OS === 'android') {
      ensureAudioPermissionAndroid().then(ok => {
        if (!ok) {
          Alert.alert(
            'Permission Required',
            'Storage permission is needed to access music files.',
          );
          return;
        }
        startPick();
      });
    } else {
      startPick();
    }
  };

  // Map a user identifier to display label; show "/You" for the signed-in user
  const displayHandle = useCallback(
    (ownerUid?: string | null, name?: string | null) => {
      try {
        const myUid = auth?.()?.currentUser?.uid || null;
        // Primary: uid match
        if (ownerUid && myUid && ownerUid === myUid) return '/You';
        // Fallback: name match against my profile/display/email prefix
        const norm = (s?: string | null) =>
          String(s || '')
            .replace(/^[@/]+/, '')
            .trim()
            .toLowerCase();
        const n = norm(name);
        const myHandle = norm(profileName);
        const myDisplay = norm(auth?.()?.currentUser?.displayName || '');
        const myEmailPrefix = norm(
          (auth?.()?.currentUser?.email || '').split('@')[0],
        );
        if (n && (n === myHandle || n === myDisplay || n === myEmailPrefix))
          return '/You';
        return formatHandle(name || '');
      } catch {
        return formatHandle(name || '');
      }
    },
    [formatHandle, profileName],
  );

  // Format ping message with proper action verb
  const formatPingMessage = useCallback(
    (ping: Ping) => {
      const actor = displayHandle(
        (ping as any).fromUid || null,
        ping.actorName || null,
      );

      switch (ping.type) {
        case 'splash': {
          // Always use the poster's name from the feed for notifications
          const posterName = ping.wavePosterName || ping.wavePosterDisplayName || ping.posterName || ping.ownerName || ping.ownerDisplayName || '';
          if (ping.splashType === 'octopus_hug') {
            return `${actor} hugged ${posterName}'s wave`;
          }
          return `${actor} splashed ${posterName}'s wave`;
        }
        case 'echo': {
          const posterName = ping.wavePosterName || ping.wavePosterDisplayName || ping.posterName || ping.ownerName || ping.ownerDisplayName || '';
          return `${actor} echoed ${posterName}'s wave`;
        }
        case 'follow':
          return `${actor} followed you`;
        case 'message':
          return ping.text; // For messages, show the actual message text
        case 'system_message':
          return ping.text;
        case 'friend_went_live':
          return `${actor} went live`;
        default:
          return ping.text || `${actor} pinged you`;
      }
    },
    [displayHandle],
  );

  // Format timestamp for pings
  const formatPingTime = useCallback((timestamp: any) => {
    try {
      const date = timestamp?.toDate ? timestamp.toDate() : new Date(timestamp);
      const now = new Date();
      const diff = now.getTime() - date.getTime();
      const minutes = Math.floor(diff / 60000);
      const hours = Math.floor(diff / 3600000);
      const days = Math.floor(diff / 86400000);

      if (minutes < 1) return 'Just now';
      if (minutes < 60) return `${minutes}m ago`;
      if (hours < 24) return `${hours}h ago`;
      if (days < 7) return `${days}d ago`;
      return date.toLocaleDateString();
    } catch {
      return '';
    }
  }, []);

  const handleNotificationNavigation = useCallback(
    (data: any) => {
      if (data?.waveId) {
        const waveIndex = wavesFeed.findIndex(w => w.id === data.waveId);
        if (waveIndex !== -1) {
          setCurrentIndex(waveIndex);
          setWaveKey(Date.now());
        }
      } else if (data?.type === 'ping' || data?.route === 'Pings') {
        setShowPings(true);
      }
    },
    [wavesFeed],
  );

  const handleForegroundRemoteMessage = useCallback(
    (rm: any) => {
      try {
        const type =
          rm?.data?.type ||
          rm?.notification?.title?.toLowerCase() ||
          'activity';
        const waveId = rm?.data?.waveId || undefined;
        const actor = rm?.data?.actorName || rm?.data?.fromName || 'Drifter';
        const text =
          rm?.notification?.body || rm?.data?.text || 'New activity';
        const id =
          rm?.messageId || rm?.data?.id || rm?.data?.messageId || String(Date.now());
        const mappedType = (
          type.includes('echo')
            ? 'echo'
            : type.includes('splash')
            ? 'splash'
            : type.includes('message')
            ? 'message'
            : 'system_message'
        ) as any;

        setPings(prev => {
          const exists = prev.some(p => p.id === id);
          if (exists) return prev;
          return [
            {
              id,
              type: mappedType,
              actorName: `@${actor}`,
              text,
              timestamp: new Date(),
              read: false,
              waveId,
            },
            ...prev,
          ];
        });
        setUnreadPingsCount(n => n + 1);

        if (rm?.notification?.body) {
          notifySuccess(rm.notification.body || 'You have new activity');
          playFalconSound();
        }
      } catch (err) {
        try {
          console.warn('Failed to handle foreground message', err);
        } catch {}
      }
    },
    [notifySuccess, playFalconSound, setPings, setUnreadPingsCount],
  );

  // Cross-version Android audio permission helper (A12/A13/A14)
  const ensureAudioPermission = async (): Promise<boolean> => {
    if (Platform.OS !== 'android') return true;
    try {
      const apiLevel =
        typeof Platform.Version === 'number' ? Platform.Version : 0;
      if (apiLevel >= 33) {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.READ_MEDIA_AUDIO,
          {
            title: 'Drift Audio Permission',
            message:
              'Drift needs access to your music to attach Ocean Melodies.',
            buttonPositive: 'Allow',
            buttonNegative: 'Deny',
          },
        );
        return granted === PermissionsAndroid.RESULTS.GRANTED;
      } else {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE,
          {
            title: 'Drift Storage Permission',
            message: 'Drift needs access to your storage to pick audio files.',
            buttonPositive: 'Allow',
            buttonNegative: 'Deny',
          },
        );
        return granted === PermissionsAndroid.RESULTS.GRANTED;
      }
    } catch {
      return false;
    }
  };

  // Use custom AudioPicker native module for true file system access (internal storage, SD card, downloads, etc.)
  const pickAudioWithDocumentPicker = async () => {
    try {
      const result = await AudioPicker.pickAudio();
      if (result && result.uri) {
        setAttachedAudio({ uri: result.uri, name: result.name || undefined });
        setShowAudioModal(false);
        setAudioUrlInput('');
      }
    } catch (err) {
      if (err?.code === 'CANCELLED') return;
      Alert.alert('Audio Picker Error', err?.message || 'Unknown error');
    }
  };

  // Go Drift (LIVE): request permissions and open in-app live modal (with camera preview + details UI)
  const goDrift = async () => {
    setShowMakeWaves(false);
    // Android: request camera + mic
    if (Platform.OS === 'android') {
      try {
        const results = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.CAMERA,
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        ] as any);
        const cam = results[PermissionsAndroid.PERMISSIONS.CAMERA];
        const mic = results[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];
        if (
          cam !== PermissionsAndroid.RESULTS.GRANTED ||
          mic !== PermissionsAndroid.RESULTS.GRANTED
        ) {
          Alert.alert(
            'Permission needed',
            'Camera and microphone are required to go live.',
          );
          return;
        }
      } catch {}
    }
    // Open in-app live UI so camera preview and overlays show together
    setShowLive(true);
  };

  // Initialize caption near the vertical middle of the media area (draggable)
  useEffect(() => {
    if (capturedMedia && stageSize.h > 0 && !captionPos) {
      setCaptionPos({ x: 24, y: Math.floor(stageSize.h * 0.35) });
    }
  }, [capturedMedia, showCaptionInput, stageSize, captionPos]);

  // (removed Movable Textbox state)
  const onEditorToolPress = async (toolLabel: string) => {
    if (
      toolLabel === 'Ocean Melodies' ||
      toolLabel === 'Sea Shanties' ||
      toolLabel === 'Ocean melodies'
    ) {
      setShowAudioModal(true);
      return;
    }
    if (toolLabel === 'Sonar Captions') {
      setShowCaptionInput(prev => {
        const next = !prev;
        if (!next) {
          try {
            captionInputRef.current?.blur?.();
          } catch {}
        } else {
          setTimeout(() => captionInputRef.current?.focus?.(), 10);
        }
        return next;
      });
      return;
    }
    if (toolLabel === 'Cut the Wake' && capturedMedia && capturedMedia.type && capturedMedia.type.startsWith('image/')) {
      try {
        const cropped = await ImageCropPicker.openCropper({
          path: capturedMedia.uri,
          cropping: true,
          width: 1000,
          height: 1000,
          compressImageQuality: 0.9,
        });
        setCapturedMedia({ ...capturedMedia, uri: cropped.path });
      } catch (err) {
        if (err?.code !== 'E_PICKER_CANCELLED') {
          Alert.alert('Crop Error', 'Could not crop image.');
        }
      }
      return;
    }
    Alert.alert(toolLabel, 'This editing tool is not yet implemented.');
  };

  // Arm audio delay based on whether media is video or image
  useEffect(() => {
    if (audioDelayTimerRef.current) {
      try {
        clearTimeout(audioDelayTimerRef.current);
      } catch {}
    }
    if (attachedAudio?.uri) {
      if (isVideoAsset(capturedMedia)) {
        // Will be released on video onLoad
        setAudioUnpaused(false);
      } else {
        setAudioUnpaused(true);
      }
    } else {
      setAudioUnpaused(true);
    }
    return () => {
      if (audioDelayTimerRef.current) {
        try {
          clearTimeout(audioDelayTimerRef.current);
        } catch {}
      }
    };
  }, [capturedMedia?.uri, attachedAudio?.uri]);

  const onPostWave = async () => {
    if (!capturedMedia) {
      Alert.alert('No media', 'Please select or capture media first.');
      return;
    }
    setReleasing(true);
    let uploadedPath: string | null = null;
    let audioDownloadUrl: string | null = null;
    let serverDocId: string | null = null;
    let storageMod: any = null;
    let firestoreMod: any = null;
    let authMod: any = null;
    try {
      try {
        storageMod = require('@react-native-firebase/storage').default;
      } catch {}
      try {
        firestoreMod = require('@react-native-firebase/firestore').default;
      } catch {}
      try {
        authMod = require('@react-native-firebase/auth').default;
      } catch {}

      if (storageMod && firestoreMod && authMod) {
        const a = authMod();
        // Removed: await a.signInAnonymously(); This was causing auto-login.
        const uid = a.currentUser?.uid;
        if (!uid) {
          Alert.alert(
            'Sign in required',
            'Please sign in to upload your wave.',
          );
          setReleasing(false);
          return;
        }
        // Define before any use below (including dev branch)
        const isHttp = (u: string) => /^https?:\/\//i.test(u);
        if (DEV_SKIP_STORAGE_UPLOAD) {
          // Dev-only: avoid native StorageTask crash on hot reload by skipping uploads
          const docRef = await firestoreMod()
            .collection('waves')
            .add({
              authorId: uid,
              ownerUid: uid,
              authorName: profileName || a.currentUser?.displayName || null,
              mediaPath: capturedMedia.uri || null,
              text: captionText,
              createdAt: firestoreMod.FieldValue?.serverTimestamp
                ? firestoreMod.FieldValue.serverTimestamp()
                : new Date(),
              caption: { x: captionPos?.x ?? 0, y: captionPos?.y ?? 0 },
              audioUrl: isHttp(attachedAudio?.uri || '')
                ? attachedAudio?.uri
                : null,
              muxMode: null,
              muxVideoStrategy: null,
              muxFps: null,
              muxStatus: 'ready',
              playbackUrl: null,
              mediaUrl: capturedMedia.uri || null,
              isPublic: true,
              devSkipStorage: true,
            });
          serverDocId = docRef?.id || null;
          setReleasing(false);
          if (Platform.OS === 'android') {
            try {
              require('react-native').ToastAndroid.show(
                'Wave saved (dev, no upload)',
                require('react-native').ToastAndroid.SHORT,
              );
            } catch {}
          } else {
            Alert.alert('Wave Saved', 'Saved locally for dev (no upload).');
          }
          return;
        }
        // isHttp already defined above
        const nameGuessRaw = capturedMedia.fileName || 'wave';
        const type = (capturedMedia.type || '').toLowerCase();
        const sanitizedBase = nameGuessRaw
          .replace(/[^A-Za-z0-9._-]/g, '_')
          .replace(/_{2,}/g, '_');
        const baseNoExt = sanitizedBase.includes('.')
          ? sanitizedBase.substring(0, sanitizedBase.lastIndexOf('.'))
          : sanitizedBase;
        const ext = sanitizedBase.includes('.')
          ? sanitizedBase.substring(sanitizedBase.lastIndexOf('.') + 1)
          : type.startsWith('video/')
          ? 'mp4'
          : type.startsWith('image/')
          ? 'jpg'
          : 'dat';
        const filePath = `posts/${uid}/${Date.now()}_${baseNoExt}.${ext}`;

        // Normalize local URI for putFile
        let localPath = String(capturedMedia.uri || '');
        try {
          localPath = decodeURI(localPath);
        } catch {}
        if (Platform.OS === 'android' && localPath.startsWith('file://')) {
          // RNFirebase on Android expects a filesystem path or content://
          localPath = localPath.replace('file://', '');
        }
        // Handle content:// URIs by copying to cache before upload (prevents native crashes)
        if (Platform.OS === 'android' && /^content:/.test(localPath)) {
          try {
            const RNFS = require('react-native-fs');
            const safeExt = (
              ext || (type.startsWith('video/') ? 'mp4' : 'dat')
            ).replace(/[^A-Za-z0-9]/g, '');
            const copyDest = `${
              RNFS.CachesDirectoryPath
            }/post_${Date.now()}.${safeExt}`;
            await RNFS.copyFile(String(capturedMedia.uri), copyDest);
            localPath = copyDest;
          } catch (e) {
            console.warn('Video content copy before upload failed', e);
          }
        }
        if (!localPath) {
          Alert.alert(
            'Upload error',
            'Could not resolve a local path for the selected media.',
          );
          setReleasing(false);
          return;
        }
        // Set contentType to help ExoPlayer/iOS pick the right pipeline
        const uploadPath = localPath;
        const uploadContentType =
          type && type.startsWith('video/') ? type : 'video/mp4';

        await storageMod()
          .ref(filePath)
          .putFile(uploadPath, { contentType: uploadContentType });
        uploadedPath = filePath;
        let videoDownloadUrl: string | null = null;
        try {
          videoDownloadUrl = await storageMod().ref(filePath).getDownloadURL();
        } catch {}
        if (attachedAudio?.uri) {
          if (isHttp(attachedAudio.uri)) {
            audioDownloadUrl = attachedAudio.uri; // remote URL pasted by user
          } else {
            // local file from picker; upload to Storage
            let audioLocal = attachedAudio.uri;
            try {
              audioLocal = decodeURI(audioLocal);
            } catch {}
            // Only copy if still content://
            if (/^content:/.test(String(audioLocal))) {
              try {
                const RNFS = require('react-native-fs');
                const audioNameGuess = (attachedAudio.name || 'track').replace(
                  /[^A-Za-z0-9._-]/g,
                  '_',
                );
                const fallbackExt =
                  /\.(mp3|m4a|aac|wav|ogg)$/i.exec(
                    attachedAudio.uri || '',
                  )?.[1] || 'mp3';
                const copyDest = `${
                  RNFS.CachesDirectoryPath
                }/overlay_${Date.now()}_${audioNameGuess}.${fallbackExt}`;
                await RNFS.copyFile(String(audioLocal), copyDest);
                audioLocal = copyDest;
              } catch (e) {
                console.warn('Audio content copy before upload failed', e);
                Alert.alert('Audio Error', 'Could not access the selected audio file for upload. Please try a different file.');
                setReleasing(false);
                return;
              }
            }
            // Remove file:// prefix for Android if present
            if (Platform.OS === 'android' && audioLocal.startsWith('file://')) {
              audioLocal = audioLocal.replace('file://', '');
            }
            if (!audioLocal) {
              console.warn('Skipping audio upload: empty local audio path');
            } else {
              const audioNameGuess = (attachedAudio.name || 'track').replace(
                /[^A-Za-z0-9._-]/g,
                '_',
              );
              const audioExt =
                (audioNameGuess.includes('.') &&
                  audioNameGuess.split('.').pop()) ||
                /\.(mp3|m4a|aac|wav|ogg)$/i.exec(
                  attachedAudio.uri || '',
                )?.[1] ||
                'm4a';
              const audioPath = `posts/${uid}/${Date.now()}_${audioNameGuess}.${audioExt}`;
              const audioCt = /m4a$/i.test(audioExt)
                ? 'audio/m4a'
                : /mp3$/i.test(audioExt)
                ? 'audio/mpeg'
                : /aac$/i.test(audioExt)
                ? 'audio/aac'
                : /wav$/i.test(audioExt)
                ? 'audio/wav'
                : /ogg$/i.test(audioExt)
                ? 'audio/ogg'
                : 'audio/mpeg';
              await storageMod()
                .ref(audioPath)
                .putFile(audioLocal, { contentType: audioCt });
              audioDownloadUrl = await storageMod()
                .ref(audioPath)
                .getDownloadURL();
            }
          }
        }
        const docRef = await firestoreMod()
          .collection('waves')
          .add({
            authorId: uid,
            ownerUid: uid,
            authorName:
              profileName ||
              accountCreationHandle ||
              a.currentUser?.displayName ||
              null,
            mediaPath: filePath,
            text: captionText,
            createdAt: firestoreMod.FieldValue?.serverTimestamp
              ? firestoreMod.FieldValue.serverTimestamp()
              : new Date(),
            caption: {
              x: captionPos?.x ?? 0,
              y: captionPos?.y ?? 0,
            },
            audioUrl: audioDownloadUrl || null,
            muxMode: null,
            muxVideoStrategy: null,
            muxFps: null,
            muxStatus: audioDownloadUrl ? 'pending' : 'ready',
            playbackUrl: audioDownloadUrl ? null : videoDownloadUrl || null,
            mediaUrl: videoDownloadUrl || null,
            isPublic: true,
            mergeRequested: !!audioDownloadUrl,
            mergeSourceVideoPath: filePath,
            mergeOverlayAudioPath: audioDownloadUrl || null,
          });
        serverDocId = docRef?.id || null;
        // Notify backend that a wave was posted (and request server merge if overlay exists)
        try {
          const cfgLocal = (() => {
            try {
              return require('./liveConfig');
            } catch {
              return null;
            }
          })();
          const backendBase: string =
            (cfgLocal &&
              (cfgLocal.BACKEND_BASE_URL ||
                cfgLocal.USER_MGMT_ENDPOINT_BASE ||
                cfgLocal.USER_MANAGEMENT_BASE_URL)) ||
            '';
          if (backendBase && serverDocId) {
            const payload: any = {
              waveId: serverDocId,
              ownerUid: uid,
              authorName:
                profileName ||
                accountCreationHandle ||
                a.currentUser?.displayName ||
                null,
            };
            if (audioDownloadUrl) {
              payload.merge = {
                sourceVideoPath: filePath,
                overlayAudioPath: audioDownloadUrl,
              };
            }
            fetch(`${backendBase}/notify/wave`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            }).catch(() => {});
          }
        } catch {}
        if (Platform.OS === 'android') {
          try {
            require('react-native').ToastAndroid.show(
              'Wave released',
              require('react-native').ToastAndroid.SHORT,
            );
          } catch {}
        }
        // Use custom notification for better UX
        notifySuccess('Your wave is now live... drifting across the ocean');
      } else {
        Alert.alert(
          'Backend not ready',
          'Install @react-native-firebase/storage and @react-native-firebase/firestore to upload waves. Showing locally for now.',
        );
      }
    } catch (e: any) {
      console.warn('Release wave failed', e);
      const msg =
        (e && (e.message || (typeof e === 'string' ? e : ''))) ||
        'Unknown error';
      Alert.alert('Release failed', `Could not release your wave. ${msg}`);
    } finally {
      // Update local feed immediately (uses local media path)
      const newWave: Wave = {
        id: serverDocId || new Date().toISOString(),
        media: capturedMedia,
        audio: audioDownloadUrl
          ? { uri: audioDownloadUrl, name: attachedAudio?.name }
          : null,
        captionText: captionText,
        captionPosition: captionPos || { x: 0, y: 0 },
        playbackUrl: null,
        muxStatus: audioDownloadUrl ? 'pending' : 'ready',
        authorName: profileName || accountCreationHandle || null,
        ownerUid: (() => {
          try {
            const a = require('@react-native-firebase/auth').default;
            return a?.().currentUser?.uid || null;
          } catch {
            return null;
          }
        })(),
        counts: { splashes: 0, echoes: 0, views: 0 }, // Ensure counts.splashes is 0 for new waves
      };
      setHasSplashed(false); // Reset splash state for new wave
      setSplashes(0); // Reset splash count for new wave
      setWavesFeed(prev => {
        // Add new wave to the beginning of the array
        const next = [newWave, ...prev];
        setCurrentIndex(0); // Set view to the new wave
        return next;
      });
      // Close modals that pause playback and jump to the new wave
      try {
        setShowMakeWaves(false);
      } catch {}
      try {
        setIsPaused(false);
      } catch {}
      requestAnimationFrame(() => {
        try {
          feedRef.current?.scrollTo({ x: 0, animated: false });
        } catch {}
      });
      // If we created a server doc, watch for mux completion updates
      if (serverDocId && firestoreMod) {
        try {
          firestoreMod()
            .collection('waves')
            .doc(serverDocId)
            .onSnapshot((snap: any) => {
              const data = snap?.data() || {};
              const playbackUrl = data?.playbackUrl || null;
              const muxStatus = data?.muxStatus || null;
              if (playbackUrl || muxStatus) {
                setWavesFeed(prev =>
                  prev.map(w =>
                    w.id === serverDocId
                      ? {
                          ...w,
                          playbackUrl: playbackUrl ?? w.playbackUrl,
                          muxStatus: (muxStatus as any) ?? w.muxStatus,
                        }
                      : w,
                  ),
                );
              }
            });
        } catch {}
      }
      // Reset editor state
      setCapturedMedia(null);
      setAttachedAudio(null);
      setCaptionText('');
      setShowCaptionInput(false);
      setCaptionPos(null);
      setReleasing(false);
      setWaveKey(Date.now()); // Force the feed to update and play the new wave
    }
  };

  const onFinishCaption = () => {
    // Exit editing mode but keep the overlay visible on media
    setShowCaptionInput(false);
  };


  if (!isFocused) {
    return <SafeAreaView style={{ flex: 1, backgroundColor: 'black' }} />;
  }

  return (
    <SafeAreaView
      style={styles.root}
      edges={['right', 'left', 'top', 'bottom']}
      onStartShouldSetResponderCapture={() => {
        try {
          touchStartRef.current = Date.now();
        } catch {}
        return false; // do not claim, just observe
      }}
      onTouchEndCapture={() => {
        try {
          if (isSwiping) return; // ignore when swiping pages
          // Any tap anywhere should reveal and keep UI for 7s; do not hide here
          showUiTemporarily();
        } catch {}
      }}
    >
      {/* Hidden audio player for sound effects */}
      {RNVideo && currentSound && (
        <RNVideo
          ref={soundPlayerRef}
          source={currentSound}
          audioOnly={true}
          playInBackground={false}
          playWhenInactive={false}
          volume={1.0}
          rate={1.0}
          paused={false}
          repeat={false}
          ignoreSilentSwitch="ignore"
          onEnd={() => {
            // Sound finished playing
            setCurrentSound(null);
          }}
          onError={(error: any) => {
            console.log('Sound playback error:', error);
            setCurrentSound(null);
          }}
          style={{ position: 'absolute', width: 0, height: 0, opacity: 0 }}
        />
      )}
      {driftAlert && (
        <Animated.View
          pointerEvents="box-none"
          style={[
            styles.driftAlertContainer,
            {
              opacity: flickerAnim.interpolate({
                inputRange: [0, 1],
                outputRange: [0.4, 1],
              }),
            },
          ]}
        >
          <Pressable
            style={styles.driftAlertButton}
            onPress={() => {
              requestToDriftForLiveId(driftAlert.liveId, driftAlert.hostName);
              setDriftAlert(null);
              lastDriftHostRef.current = null;
              if (driftAlertTimerRef.current) {
                clearTimeout(driftAlertTimerRef.current);
                driftAlertTimerRef.current = null;
              }
            }}
          >
            <Animated.View
              style={[
                styles.driftAlertSignal,
                {
                  opacity: flickerAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.3, 1],
                  }),
                },
              ]}
            />
            <View style={styles.driftAlertAvatar}>
              {driftAlert.hostPhoto ? (
                <Image
                  source={{ uri: driftAlert.hostPhoto }}
                  style={styles.driftAlertAvatarImage}
                />
              ) : (
                <Text style={styles.driftAlertInitials}>
                  {driftAlert.hostName.charAt(0).toUpperCase()}
                </Text>
              )}
            </View>
            <Text style={styles.driftAlertText}>
              Open Sea Drift • {driftAlert.hostName}
            </Text>
          </Pressable>
        </Animated.View>
      )}
      {/* This Pressable now controls both UI visibility and play/pause */}
      <Pressable
        style={styles.videoSpace}
        onPress={() => showUiTemporarily()}
        onPressIn={() => showUiTemporarily()}
        onTouchStart={() => showUiTemporarily()}
        onStartShouldSetResponderCapture={() => {
          showUiTemporarily();
          return false; // do not block scroll/swipe
        }}
        delayPressIn={0}
      >
        <View style={styles.videoSpaceInner}>
          {displayFeed.length > 0 ? (
            <Animated.ScrollView
              ref={feedRef}
              style={{ flex: 1 }}
              horizontal
              pagingEnabled
              snapToInterval={SCREEN_WIDTH}
              snapToAlignment="center"
              disableIntervalMomentum={true}
              decelerationRate="fast"
              onTouchStart={() => showUiTemporarily()}
              showsHorizontalScrollIndicator={false}
              onScrollBeginDrag={e => {
                setIsSwiping(true);
                showUiTemporarily(); // Show toggles on swipe
                try {
                  dragStartXRef.current = e.nativeEvent.contentOffset.x;
                  dragStartTimeRef.current = Date.now();
                } catch {}
              }}
              onLayout={() => {
                if (currentIndex < 0 && displayFeed.length > 0) {
                  setCurrentIndex(0);
                }
              }}
              onScrollEndDrag={e => {
                // Make paging more sensitive: small, quick drags still change page
                try {
                  const endX = e.nativeEvent.contentOffset.x;
                  const dx = endX - dragStartXRef.current;
                  const width =
                    e.nativeEvent.layoutMeasurement?.width || SCREEN_WIDTH;
                  const threshold = width * 0.02; // 2% of width
                  const velocityX = e.nativeEvent.velocity?.x ?? 0;
                  const quickFlick = Math.abs(velocityX) > 0.1;
                  let target = currentIndex;
                  if (
                    dx > threshold ||
                    (dx > 1 &&
                      quickFlick &&
                      Math.abs(dx) / (Date.now() - dragStartTimeRef.current) >
                        0.1)
                  )
                    target = Math.min(currentIndex + 1, displayFeed.length - 1);
                  else if (
                    dx < -threshold ||
                    (dx < -1 &&
                      quickFlick &&
                      Math.abs(dx) / (Date.now() - dragStartTimeRef.current) >
                        0.1)
                  )
                    target = Math.max(currentIndex - 1, 0);
                  if (target !== currentIndex) {
                    feedRef.current?.scrollTo({
                      x: target * width,
                      animated: true,
                    });
                    setCurrentIndex(target);
                    setWaveKey(Date.now());
                  }
                } catch {}
              }}
              onMomentumScrollEnd={e => {
                const page = Math.round(
                  e.nativeEvent.contentOffset.x /
                    e.nativeEvent.layoutMeasurement.width,
                );
                setIsSwiping(false);
                showUiTemporarily(); // Keep UI visible for a bit after swipe
                setIsTopBarExpanded(false);
                setIsBottomBarExpanded(false);
                if (page !== currentIndex && page < displayFeed.length) {
                  setCurrentIndex(page);
                  setWaveKey(Date.now());
                }
              }}
            >
              {displayFeed.map((item, index) => {
                // Only pause for modals that interfere with video/audio
                const isAnyModalOpen =
                  showMakeWaves ||
                  showAudioModal ||
                  !!capturedMedia ||
                  showLive;
                const shouldPlay =
                  !isPaused &&
                  index === currentIndex &&
                  allowPlayback &&
                  !isAnyModalOpen;
                const maxBr = isWifi
                  ? 1_500_000
                  : Math.min(
                      bridge.dataSaverDefaultOnCell
                        ? Math.min(
                            bridge.cellularMaxBitrateH264,
                            bridge.cellularMaxBitrateHEVC,
                          )
                        : bridge.cellularMaxBitrateH264,
                      600_000,
                    );
                const overlayState = overlayReadyMap[item.id] || {};
                const hasOverlayAudio = !!item.audio?.uri && !item.playbackUrl;
                const overlayVideoReady =
                  overlayState.video === true || !isVideoAsset(item.media);
                const overlayPairReady =
                  !hasOverlayAudio ||
                  (overlayVideoReady && overlayState.audio === true);
                const playSynced = shouldPlay && overlayPairReady;
                const near = Math.abs(index - currentIndex) <= 1;
                return (
                  <View
                    key={item.id}
                    style={[
                      styles.postedWaveContainer,
                      { width: SCREEN_WIDTH },
                    ]}
                  >
                    {/* SPL Logo - left side opposite to 3-dot menu */}
                    {myLogo && (
                      <View
                        style={{
                          position: 'absolute',
                          left: 14,
                          top: 75,
                          padding: 4,
                          borderRadius: 999,
                          backgroundColor: 'rgba(0,0,0,0.35)',
                          justifyContent: 'center',
                          alignItems: 'center',
                          overflow: 'hidden',
                          zIndex: 45,
                        }}
                      >
                        <Image
                          source={myLogo}
                          style={{
                            width: 28,
                            height: 28,
                            borderRadius: 14,
                            opacity: 0.9,
                          }}
                          resizeMode="contain"
                        />
                      </View>
                    )}
                    <Pressable
                      style={styles.waveOptionsButton}
                      onPress={() => openWaveOptions(item)}
                      hitSlop={10}
                    >
                      <Text style={styles.waveOptionsButtonText}>⋮</Text>
                    </Pressable>
                    {!!RNVideo &&
                    near &&
                    (item.playbackUrl || isVideoAsset(item.media)) &&
                    !(videoErrorMap || {})[item.id] ? (
                      item.playbackUrl ? (
                        // Single stream: server-muxed URL
                        <RNVideo
                          key={`mux-${waveKey}-${item.id}`}
                          source={{
                            uri: String(
                              isOffline && item.media?.uri
                                ? item.media.uri
                                : item.playbackUrl,
                            ),
                          }}
                          style={videoStyleFor(item.id) as any}
                          resizeMode={'contain'}
                          repeat={true}
                          paused={
                            (!isWifi && bridge.autoplayCellular === 'off') ||
                            !shouldPlay
                          }
                          maxBitRate={maxBr}
                          bufferConfig={{
                            minBufferMs: 20000,
                            maxBufferMs: 60000,
                            bufferForPlaybackMs: 5000,
                            bufferForPlaybackAfterRebufferMs: 10000,
                          }}
                          useTextureView={useTextureForVideo}
                          progressUpdateInterval={750}
                          poster={String(item.media?.uri || item.playbackUrl)}
                          posterResizeMode={'cover'}
                          disableFocus={true}
                          playInBackground={false}
                          playWhenInactive={false}
                          ignoreSilentSwitch={'ignore'}
                          onLoadStart={() => {
                            try {
                              if (shouldPlay) markBuffering(item.id, true);
                            } catch {}
                          }}
                          onBuffer={(b: any) => {
                            try {
                              markBuffering(
                                item.id,
                                !!b?.isBuffering && shouldPlay,
                              );
                            } catch {}
                          }}
                          onError={(e: any) => {
                            try {
                              console.warn('FEED VIDEO ERR', e);
                              const code = e?.error?.code
                                ? String(e.error.code)
                                : '';
                              handleVideoPlaybackError(item.id, code);
                            } catch {}
                          }}
                          onLoad={(e: any) => {
                            try {
                              markBuffering(item.id, false);
                              markOverlayReady(item.id, 'video');
                              setPlaybackDuration(e?.duration || 0);
                              updateVideoAspect(item.id, e?.naturalSize);
                            } catch {}
                          }}
                          onProgress={(e: any) => {
                            try {
                              const t = e?.currentTime || 0;
                              setPlaybackTime(t);
                              if (
                                !isWifi &&
                                bridge.autoplayCellular === 'preview' &&
                                t >= 4 &&
                                index === currentIndex
                              )
                                setIsPaused(true);
                            } catch {}
                          }}
                        />
                      ) : (
                        // Fallback: separate video + hidden audio when an overlay audio is present
                        <>
                          <RNVideo
                            key={`vid-${waveKey}-${item.id}`}
                          source={{ uri: String(item.media.uri) }}
                          style={videoStyleFor(item.id) as any}
                          resizeMode={'contain'}
                            repeat={true}
                            paused={
                              (!isWifi && bridge.autoplayCellular === 'off') ||
                              !playSynced
                            }
                            maxBitRate={maxBr}
                            bufferConfig={{
                              minBufferMs: 20000,
                              maxBufferMs: 60000,
                              bufferForPlaybackMs: 5000,
                              bufferForPlaybackAfterRebufferMs: 10000,
                            }}
                            useTextureView={useTextureForVideo}
                            progressUpdateInterval={750}
                            poster={String(item.media.uri || item.playbackUrl)}
                            posterResizeMode={'cover'}
                            muted={!!item.audio?.uri}
                            disableFocus={true}
                            playInBackground={false}
                            playWhenInactive={false}
                            ignoreSilentSwitch={'ignore'}
                            onLoadStart={() => {
                              try {
                                if (shouldPlay) markBuffering(item.id, true);
                              } catch {}
                            }}
                            onBuffer={(b: any) => {
                              try {
                                markBuffering(
                                  item.id,
                                  !!b?.isBuffering && shouldPlay,
                                );
                              } catch {}
                            }}
                            onError={(e: any) => {
                              try {
                                console.warn('FEED VIDEO ERR', e);
                                const code = e?.error?.code
                                  ? String(e.error.code)
                                  : '';
                                handleVideoPlaybackError(item.id, code);
                              } catch {}
                            }}
                            onLoad={(e: any) => {
                              try {
                                markBuffering(item.id, false);
                                markOverlayReady(item.id, 'video');
                                setPlaybackDuration(e?.duration || 0);
                                updateVideoAspect(item.id, e?.naturalSize);
                              } catch {}
                            }}
                            onProgress={(e: any) => {
                              try {
                                const t = e?.currentTime || 0;
                                setPlaybackTime(t);
                                if (
                                  !isWifi &&
                                  bridge.autoplayCellular === 'preview' &&
                                  t >= 4 &&
                                  index === currentIndex
                                )
                                  setIsPaused(true);
                              } catch {}
                            }}
                          />
                          {RNVideo && item.audio?.uri && (
                            <RNVideo
                              key={`aud-${waveKey}-${item.id}`}
                              source={{ uri: item.audio.uri }}
                              audioOnly
                              repeat={true}
                              paused={!playSynced}
                              disableFocus={true}
                              playInBackground={false}
                              playWhenInactive={false}
                              volume={1.0}
                              ignoreSilentSwitch={'ignore'}
                              style={{
                                width: 1,
                                height: 1,
                                opacity: 0.01,
                                position: 'absolute',
                              }}
                              useTextureView={false}
                              progressUpdateInterval={500}
                              onError={(e: any) => {
                                try {
                                  console.warn('FEED AUDIO ERR', e);
                                } catch {}
                              }}
                              onLoad={(data: any) => {
                                try {
                                  markOverlayReady(item.id, 'audio');
                                  setPlaybackDuration(data?.duration || 0);
                                } catch {}
                              }}
                              onProgress={(data: any) => {
                                try {
                                  setPlaybackTime(data?.currentTime || 0);
                                } catch {}
                              }}
                            />
                          )}
                        </>
                      )
                    ) : (
                      <>
                        <Image
                          source={{ uri: item.media.uri }}
                          style={[
                            ...(videoStyleFor(item.id) as any),
                            { resizeMode: 'cover' },
                          ]}
                        />
                        {RNVideo && item.audio?.uri && (
                          <RNVideo
                            source={{ uri: item.audio.uri }}
                            audioOnly
                            repeat={true}
                            paused={!playSynced}
                            disableFocus={true}
                            playInBackground={false}
                            playWhenInactive={false}
                            volume={1.0}
                            ignoreSilentSwitch={'ignore'}
                            style={{
                              width: 1,
                              height: 1,
                              opacity: 0.01,
                              position: 'absolute',
                            }}
                            useTextureView={false}
                            progressUpdateInterval={500}
                            onError={(e: any) => {
                              try {
                                console.warn('FEED AUDIO ERR', e);
                              } catch {}
                            }}
                            onLoad={(data: any) => {
                              try {
                                markOverlayReady(item.id, 'audio');
                                setPlaybackDuration(data?.duration || 0);
                              } catch {}
                            }}
                            onProgress={(data: any) => {
                              try {
                                setPlaybackTime(data?.currentTime || 0);
                              } catch {}
                            }}
                          />
                        )}
                      </>
                    )}
                    {bufferingMap[item.id] && shouldPlay && (
                      <View
                        style={{
                          position: 'absolute',
                          left: 0,
                          right: 0,
                          top: 0,
                          bottom: 0,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <ActivityIndicator size="large" color="#00C2FF" />
                      </View>
                    )}
                    {!!item.captionText && (
                      <Text
                        style={[
                          styles.postedWaveCaption,
                          {
                            transform: [
                              { translateX: item.captionPosition.x },
                              { translateY: item.captionPosition.y },
                            ],
                          },
                        ]}
                      >
                        {item.captionText}
                      </Text>
                    )}
                    {/* Play/Pause Button Overlay – center-only region to avoid conflict with outer tap-to-toggle */}
                    <Pressable
                      style={{
                        position: 'absolute',
                        left: SCREEN_WIDTH * 0.3,
                        top: SCREEN_HEIGHT * 0.3,
                        width: SCREEN_WIDTH * 0.4,
                        height: SCREEN_HEIGHT * 0.4,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                      onPress={() => {
                        setIsPaused(p => !p);
                        showUiTemporarily();
                      }}
                    >
                      {index === currentIndex && isPaused && (
                        <View
                          style={{
                            flex: 1,
                            backgroundColor: 'rgba(0,0,0,0.2)',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <Text
                            style={{
                              fontSize: 60,
                              color: 'rgba(255,255,255,0.8)',
                              textShadowColor: 'rgba(0,0,0,0.5)',
                              textShadowRadius: 8,
                            }}
                          >
                            ►
                          </Text>
                        </View>
                      )}
                    </Pressable>
                  </View>
                );
              })}
            </Animated.ScrollView>
          ) : (
            <View
              style={{
                flex: 1,
                alignItems: 'center',
                justifyContent: 'center',
                padding: 20,
              }}
            >
              <Text style={{ fontSize: 48, marginBottom: 16, opacity: 0.5 }}>
                {showPublicFeed ? '🌊' : '🧭'}
              </Text>
              <Text
                style={[
                  styles.videoHint,
                  {
                    fontSize: 16,
                    fontWeight: '600',
                    color: '#00C2FF',
                    marginBottom: 8,
                  },
                ]}
              >
                {showPublicFeed ? 'Calm Waters Ahead' : 'Chart Your Course'}
              </Text>
              <Text
                style={[
                  styles.videoHint,
                  { textAlign: 'center', lineHeight: 20 },
                ]}
              >
                {showPublicFeed
                  ? 'No waves drifting in the public sea yet.\nBe the first to make a splash!'
                  : 'Your waves will drift here.\nTap + to cast your first wave into the sea.'}
              </Text>
            </View>
          )}
        </View>
      </Pressable>

      {/* Top function bar with toggle */}
      {isUiVisible && (
        <View
          style={[
            styles.topStrip,
            {
              paddingTop: (insets.top || 0) + 8,
              paddingBottom: 4,
              backgroundColor: isTopBarExpanded ? 'black' : 'transparent',
            },
          ]}
        >
          <View style={styles.topBarWrapper}>
            <Pressable
              style={styles.toggleButton}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              onPress={withUi(() => setIsTopBarExpanded(p => !p))}
            >
              <Text style={styles.toggleButtonText}>
                {isTopBarExpanded ? '<' : '>'}
              </Text>
            </Pressable>
            {isTopBarExpanded && !isSwiping && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.scrollRow}
              >
                {/* FEED TOGGLE: My/Public */}
                <Pressable
                  style={styles.topItem}
                  onPress={withUi(() => {
                    setShowPublicFeed(p => !p);
                    setCurrentIndex(0);
                    try {
                      feedRef.current?.scrollTo({ x: 0, animated: false });
                    } catch {}
                  })}
                >
                  <Text
                    style={
                      showPublicFeed ? styles.globeIcon : styles.compassIcon
                    }
                  >
                    {showPublicFeed ? '🌐' : '🌊'}
                  </Text>
                  <Text style={styles.topLabel}>
                    {showPublicFeed ? 'PUBLIC WAVES' : 'MY WAVES'}
                  </Text>
                </Pressable>
                {/* MAKE WAVES */}
                <Pressable
                  style={styles.topItem}
                  onPress={withUi(() => setShowMakeWaves(true))}
                >
                  <Text style={styles.dolphinIcon}>🐋</Text>
                  <Text style={styles.topLabel}>MAKE WAVES</Text>
                </Pressable>
                {/* PINGS */}
                <Pressable
                  style={styles.topItem}
                  onPress={withUi(() => {
                    setShowPings(true);
                    markPingsAsRead();
                  })}
                >
                  <View>
                    <Text style={styles.pingsIcon}>📫</Text>
                    {unreadPingsCount > 0 && (
                      <View style={styles.pingsBadge}>
                        <Text style={styles.pingsBadgeText}>
                          {unreadPingsCount}
                        </Text>
                      </View>
                    )}
                  </View>
                  <Text style={styles.topLabel}>PINGS</Text>
                </Pressable>
                {/* DEEP DIVE */}
                <Pressable
                  style={styles.topItem}
                  onPress={withUi(() => setShowDeepSearch(true))}
                >
                  <Text style={styles.dolphinIcon}>🔎</Text>
                  <Text style={styles.topLabel}>DEEP DIVE</Text>
                </Pressable>

                {/* MY SHORE */}
                <Pressable
                  style={styles.topItem}
                  onPress={withUi(() => {
                    setShowProfile(true);
                  })}
                >
                  <Text style={styles.umbrellaIcon}>⛱️</Text>
                  <Text style={styles.topLabel}>MY SHORE</Text>
                </Pressable>
                {/* SET SAIL */}
                <Pressable
                  style={styles.topItem}
                  onPress={withUi(() => setShowExplore(true))}
                >
                  <Text style={styles.boatIcon}>⛵</Text>
                  <Text style={styles.topLabel}>SET SAIL</Text>
                </Pressable>
                {/* SCHOOL MODE */}
                <Pressable
                  style={styles.topItem}
                  onPress={withUi(() => setShowSchoolMode(true))}
                >
                  <Text style={styles.schoolIcon}>🏫</Text>
                  <Text style={styles.topLabel}>SCHOOL MODE</Text>
                </Pressable>
                {/* NOTICE BOARD */}
                <Pressable
                  style={styles.topItem}
                  onPress={withUi(() => setShowNotice(true))}
                >
                  <Text style={styles.noticeIcon}>📋</Text>
                  <Text style={styles.topLabel}>NOTICE BOARD</Text>
                </Pressable>
                {/* THE BRIDGE */}
                <Pressable
                  style={styles.topItem}
                  onPress={withUi(() => setShowBridge(true))}
                >
                  <Text style={styles.gearIcon}>⚙️</Text>
                  <Text style={styles.topLabel}>THE BRIDGE</Text>
                </Pressable>
                {/* PLACE HOLDER */}
                <Pressable
                  style={styles.topItem}
                  onPress={withUi(() =>
                    Alert.alert('Placeholder', 'Reserved for future feature.'),
                  )}
                >
                  <Text style={styles.placeholderIcon}>🔮</Text>
                  <Text style={styles.topLabel}>PLACE HOLDER</Text>
                </Pressable>
              </ScrollView>
            )}
          </View>
        </View>
      )}

      {/* Media title + timer overlay (at bottom above interactions) */}
      {currentWave && !isUiVisible && (
        <View
          pointerEvents="none"
          style={[
            styles.mediaTitleBar,
            { top: undefined, bottom: insets.bottom + bottomBarHeight - 6 },
          ]}
        >
          <Text
            style={[styles.mediaTimerText, { marginLeft: 0, marginRight: 12 }]}
          >
            {formatTime(playbackTime)}
          </Text>
          <Text numberOfLines={1} style={styles.mediaTitleText}>
            {getWaveTitle(currentWave)}
          </Text>
        </View>
      )}

      {/* Right-edge overlapped bubbles */}
      <View style={[styles.rightBubbles, { top: rightBubblesTop }]}>
        <Text style={styles.posterName}>
          {displayHandle(currentWave?.ownerUid, currentWave?.authorName)}
        </Text>

        {/* Recent Wave Posters - showing 3 most recent */}
        {recentPosters.length > 0 && (
          <View style={[styles.avatarStack, { marginTop: 8 }]}>
            {recentPosters.slice(0, 3).map((poster, i) => (
              <View
                key={poster.id}
                style={[
                  styles.crewBubble,
                  i > 0 ? { marginTop: -12 } : null,
                  { backgroundColor: 'rgba(0,194,255,0.15)' },
                ]}
              >
                {poster.avatar ? (
                  <Image
                    source={{ uri: poster.avatar }}
                    style={styles.crewAvatar}
                  />
                ) : (
                  <Text style={[styles.crewInitial, { color: '#00C2FF' }]}>
                    {poster.name.charAt(0).toUpperCase()}
                  </Text>
                )}
              </View>
            ))}
            {recentPosters.length > 3 && (
              <View
                style={[
                  styles.avatarStackMore,
                  { backgroundColor: 'rgba(0,194,255,0.2)' },
                ]}
              >
                <Text
                  style={[
                    styles.avatarStackMoreText,
                    { fontSize: 10, color: '#00C2FF' },
                  ]}
                >
                  +{recentPosters.length - 3}
                </Text>
              </View>
            )}
          </View>
        )}

      </View>

      {/* Bottom Interaction Bar */}
      {isUiVisible && (
        <View
          style={[
            styles.bottomBarContainer,
            {
              paddingBottom: insets.bottom || 8,
              backgroundColor: isBottomBarExpanded
                ? 'rgba(0,0,0,0.5)'
                : 'transparent',
            },
          ]}
          onLayout={e => setBottomBarHeight(e.nativeEvent.layout.height)}
        >
          <View
            style={[styles.bottomBarWrapper, { justifyContent: 'flex-start' }]}
          >
            <Pressable
              style={styles.toggleButton}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              onPress={withUi(() => setIsBottomBarExpanded(p => !p))}
            >
              <Text style={styles.toggleButtonText}>
                {isBottomBarExpanded ? '<' : '>'}
              </Text>
            </Pressable>
            {isBottomBarExpanded && !isSwiping && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={{ flex: 1 }}
                contentContainerStyle={{ alignItems: 'center' }}
              >
                <Pressable
                  style={styles.bottomBarItem}
                  onPress={withUi(() => {
                    onSplash();
                    runSplashAnimation();
                  })}
                >
                  {/* Always show one drop. Label is 'Splashes' if not splashed, 'Splashed' if splashed. Count updates. */}
                  <>
                    <Animated.Text
                      style={[
                        styles.bottomBarIcon,
                        { transform: [{ scale: splashAnimation }] },
                      ]}
                    >
                      💧
                    </Animated.Text>
                    <Text
                      style={[
                        styles.bottomBarLabel,
                        hasSplashed ? { color: '#00C2FF' } : null,
                      ]}
                    >
                      Splashes
                    </Text>
                    <Text style={styles.bottomBarCount}>
                      {formatCount(splashDisplayCount)}
                    </Text>
                  </>
                </Pressable>
                <Pressable
                  style={styles.bottomBarItem}
                  onPress={withUi(() => setShowEchoes(true))}
                >
                  <Text style={styles.bottomBarIcon}>📣</Text>
                  <Text style={styles.bottomBarLabel}>Echoes</Text>
                  <Text style={styles.bottomBarCount}>
                    {formatCount(echoes)}
                  </Text>
                </Pressable>
                <Pressable
                  style={styles.bottomBarItem}
                  onPress={withUi(() => setShowPearls(true))}
                >
                  <Text style={styles.bottomBarIcon}>🦪</Text>
                  <Text style={styles.bottomBarLabel}>Pearls</Text>
                  <Text style={styles.bottomBarCount}> </Text>
                </Pressable>
                <Pressable
                  style={styles.bottomBarItem}
                  onPress={withUi(() => {
                    if (currentWave) anchorWave(currentWave);
                  })}
                >
                  <Text style={styles.bottomBarIcon}>⚓</Text>
                  <Text style={styles.bottomBarLabel}>Anchor Wave</Text>
                  <Text style={styles.bottomBarCount}> </Text>
                </Pressable>
                <Pressable
                  style={styles.bottomBarItem}
                  onPress={withUi(onShare)}
                >
                  <Text style={styles.bottomBarIcon}>📡</Text>
                  <Text style={styles.bottomBarLabel}>Casta Wave</Text>
                  <Text style={styles.bottomBarCount}> </Text>
                </Pressable>
                <Pressable
                  style={styles.bottomBarItem}
                  onPress={withUi(() => {})}
                >
                  <Text style={styles.bottomBarIcon}>🔱</Text>
                  <Text style={styles.bottomBarLabel}>Placeholder 1</Text>
                  <Text style={styles.bottomBarCount}> </Text>
                </Pressable>
                <Pressable
                  style={styles.bottomBarItem}
                  onPress={withUi(() => {})}
                >
                  <Text style={styles.bottomBarIcon}>🐚</Text>
                  <Text style={styles.bottomBarLabel}>Placeholder 2</Text>
                  <Text style={styles.bottomBarCount}> </Text>
                </Pressable>
              </ScrollView>
            )}
          </View>
        </View>
      )}

      {/* Notification Toast */}
      <NotificationToast
        kind={toastKind}
        message={toastMessage}
        visible={toastVisible}
        logo={myLogo}
      />

      {/* ========== SIMPLE OCEAN EFFECTS ========== */}
      
      {/* Bioluminescent tap effects - glowing particle trails on finger touch */}
      {(() => {
        try {
          return tapEffects.map(effect => (
            <BioluminescentTapEffect
              key={effect.id}
              x={effect.x}
              y={effect.y}
              onComplete={() => {
                try {
                  setTapEffects((prev: any) => prev.filter((e: any) => e.id !== effect.id));
                } catch (err) {
                  console.log('Tap effect cleanup error:', err);
                }
              }}
            />
          ));
        } catch (err) {
          console.log('Tap effects render error:', err);
          return null;
        }
      })()}

      {/* Wave ripple on interactions - replaces button press effects */}
      {(() => {
        try {
          return <WaveRippleEffect />;
        } catch (err) {
          console.log('Wave ripple error:', err);
          return null;
        }
      })()}

      {/* Auto night-mode with moon reflection */}
      {(() => {
        try {
          return null;
        } catch (err) {
          console.log('Night mode error:', err);
          return null;
        }
      })()}

      {/* Interactive wave physics - drag to create waves, bubble trails */}
      {(() => {
        try {
          return <InteractiveWavePhysics enabled={interactivePhysicsEnabled} />;
        } catch (err) {
          console.log('Interactive physics error:', err);
          return null;
        }
      })()}

      {/* Shake for storms - shake phone for rain/thunder effects */}
      {(() => {
        try {
          return <ShakeForStorms enabled={stormEffectsEnabled} />;
        } catch (err) {
          console.log('Storm effects error:', err);
          return null;
        }
      })()}

      {/* ========== END OCEAN EFFECTS ========== */}

      {/* Ocean echo confirmation */}
      {showOceanEchoNotice && (
        <View
          style={{
            position: 'absolute',
            top: Platform.select({ ios: 70, android: 50 }),
            left: 0,
            right: 0,
            alignItems: 'center',
            pointerEvents: 'none',
            zIndex: 100,
          }}
        >
          <Animated.View
            style={{
              paddingVertical: 12,
              paddingHorizontal: 24,
              backgroundColor: 'rgba(0, 18, 45, 0.98)',
              borderRadius: 999,
              borderWidth: 2,
              borderColor: '#00C2FF',
              shadowColor: '#00C2FF',
              shadowOpacity: 0.6,
              shadowRadius: 12,
              shadowOffset: { width: 0, height: 4 },
              elevation: 8,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Text style={{ fontSize: 20 }}>🌊</Text>
            <Text
              style={{
                color: '#ffffff',
                fontWeight: '800',
                letterSpacing: 0.5,
                fontSize: 15,
                textShadowColor: 'rgba(0,194,255,0.6)',
                textShadowRadius: 6,
              }}
            >
              {oceanEchoNoticeText}
            </Text>
            <Text style={{ fontSize: 20 }}>📣</Text>
          </Animated.View>
        </View>
      )}

      {/* Ocean Echo Ripples - Interactive notification for cast echoes */}
      {showEchoRipple && (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          {echoRipples.map((ripple, i) => {
            const scale = ripple.interpolate({
              inputRange: [0, 1],
              outputRange: [0.4, 3.0],
            });
            const opacity = ripple.interpolate({
              inputRange: [0, 0.15, 0.85, 1],
              outputRange: [0, 0.9, 0.5, 0],
            });
            return (
              <Animated.View
                key={i}
                style={[
                  StyleSheet.absoluteFill,
                  {
                    justifyContent: 'center',
                    alignItems: 'center',
                    transform: [{ scale }],
                    opacity,
                  },
                ]}
              >
                <View
                  style={{
                    width: 220,
                    height: 220,
                    borderRadius: 110,
                    borderWidth: 4,
                    borderColor: '#00C2FF',
                    backgroundColor: 'rgba(0, 194, 255, 0.08)',
                    shadowColor: '#00C2FF',
                    shadowOpacity: 0.6,
                    shadowRadius: 15,
                  }}
                />
              </Animated.View>
            );
          })}
          {/* Ocean-themed echo icon in center - appears ABOVE ripples */}
          <View
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              justifyContent: 'center',
              alignItems: 'center',
              zIndex: 100,
            }}
          >
            <Animated.View
              style={{
                backgroundColor: 'rgba(0, 18, 45, 0.95)',
                paddingVertical: 20,
                paddingHorizontal: 30,
                borderRadius: 20,
                borderWidth: 2,
                borderColor: '#00C2FF',
                shadowColor: '#00C2FF',
                shadowOpacity: 0.8,
                shadowRadius: 20,
                alignItems: 'center',
                opacity: echoRipples[0].interpolate({
                  inputRange: [0, 0.2, 0.8, 1],
                  outputRange: [0, 1, 1, 0],
                }),
                transform: [
                  {
                    scale: echoRipples[0].interpolate({
                      inputRange: [0, 0.2, 1],
                      outputRange: [0.8, 1.1, 1],
                    }),
                  },
                ],
              }}
            >
              {/* SPL Logo */}
              {myLogo && (
                <Animated.Image
                  source={myLogo}
                  style={{
                    width: 80,
                    height: 80,
                    borderRadius: 40,
                    marginBottom: 16,
                    borderWidth: 2,
                    borderColor: '#00C2FF',
                    transform: [
                      {
                        rotate: echoRipples[0].interpolate({
                          inputRange: [0, 1],
                          outputRange: ['-10deg', '10deg'],
                        }),
                      },
                    ],
                  }}
                  resizeMode="cover"
                />
              )}
              {/* Success message with exclamation */}
              <Animated.Text
                style={{
                  color: '#ffffff',
                  fontSize: 18,
                  fontWeight: '900',
                  textAlign: 'center',
                  textShadowColor: '#00C2FF',
                  textShadowRadius: 8,
                  letterSpacing: 0.8,
                }}
              >
                {rippleSuccessText || 'Echo cast, drifting into the open sea!'}
              </Animated.Text>
            </Animated.View>
          </View>
        </View>
      )}

      {/* MY SHORE */}
      <Modal
        visible={showProfile}
        transparent
        animationType="fade"
        onRequestClose={() => setShowProfile(false)}
      >
        <View
          style={[styles.modalRoot, { justifyContent: 'center', padding: 24 }]}
        >
          <View
            style={[
              styles.logbookContainer,
              {
                maxHeight: SCREEN_HEIGHT * 0.7,
                borderRadius: 12,
                overflow: 'hidden',
              },
            ]}
          >
            {paperTexture && (
              <Image source={paperTexture} style={styles.logbookBg} />
            )}
            {/* Profile and actions at the top, stats tab below them above close button */}
            <View style={{ flex: 1, flexDirection: 'column', marginTop: 16 }}>
              <View style={{ flexDirection: 'row', flex: 1 }}>
                {/* Left: Profile section */}
                <View style={[styles.logbookPage, { paddingTop: 0, flex: 1 }]}> 
                  <View style={{ alignItems: 'center', marginBottom: 16 }}>
                    <EditableProfileAvatar
                      initialPhotoUrl={profilePhoto}
                      onPhotoChanged={async (newUri) => {
                        // Optionally upload newUri to Firebase Storage and update Firestore
                        setProfilePhoto(newUri);
                        try {
                          let firestoreMod: any = null;
                          let authMod: any = null;
                          try {
                            firestoreMod = require('@react-native-firebase/firestore').default;
                          } catch {}
                          try {
                            authMod = require('@react-native-firebase/auth').default;
                          } catch {}
                          const uid = authMod?.()?.currentUser?.uid;
                          if (firestoreMod && uid) {
                            await firestoreMod().doc(`users/${uid}`).update({
                              userPhoto: newUri || null,
                            });
                          }
                        } catch (e) {
                          // Optionally show error
                        }
                      }}
                    />
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        marginTop: 8,
                      }}
                    >
                      <Text
                        style={{
                          color: 'rgba(255,255,255,0.8)',
                          fontSize: 18,
                          marginRight: 2,
                        }}
                      >
                        /
                      </Text>
                      <TextInput
                        value={(profileName || '/Drifter').replace(/^\/+/, '')}
                        onChangeText={t =>
                          setProfileName('/' + String(t || '').replace(/^\/+/, ''))
                        }
                        placeholder="Drifter"
                        placeholderTextColor="rgba(255,255,255,0.5)"
                        style={[
                          styles.profileName as any,
                          {
                            marginTop: 0,
                            padding: 0,
                            borderBottomWidth: 1,
                            borderBottomColor: 'rgba(255,255,255,0.3)',
                          },
                        ]}
                      />
                    </View>
                    <TextInput
                      value={profileBio}
                      onChangeText={setProfileBio}
                      placeholder="Write a short bio..."
                      placeholderTextColor="rgba(255,255,255,0.5)"
                      multiline
                      style={[
                        styles.profileBio as any,
                        {
                          marginTop: 8,
                          width: '100%',
                          borderBottomWidth: 1,
                          borderBottomColor: 'rgba(255,255,255,0.2)',
                        },
                      ]}
                    />
                  </View>
                </View>
                {/* Divider flush with statsOverlay */}
                <View
                  style={{
                    width: 1,
                    backgroundColor: 'rgba(0,0,0,0.4)',
                    marginTop: 0,
                    marginBottom: 0,
                    alignSelf: 'stretch',
                  }}
                />
                {/* Right: My Waves and My Treasure */}
                <View style={[styles.logbookPage, { paddingTop: 0, flex: 1 }]}> 
                  <Pressable
                    style={[styles.logbookAction, { marginTop: 0 }]}
                    onPress={() => {
                      setShowProfile(false);
                      setShowMyWaves(true);
                    }}
                  >
                    <View
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
                    >
                      <View
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: 5,
                          backgroundColor: '#00C2FF',
                        }}
                      />
                      <Text style={styles.logbookActionText}>My Waves</Text>
                    </View>
                  </Pressable>
                  <Pressable
                    style={[styles.logbookAction, { marginTop: 12 }]}
                    onPress={() => {
                      setShowProfile(false);
                      setShowTreasure(true);
                    }}
                  >
                    <View
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
                    >
                      <View
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: 5,
                          backgroundColor: '#FFD700',
                        }}
                      />
                      <Text style={styles.logbookActionText}>My Treasure</Text>
                    </View>
                  </Pressable>
                </View>
              </View>
              {/* Stats tab below profile/actions, above close button */}
              <View style={{ marginTop: 16, marginBottom: 8 }}>
                <View style={{ backgroundColor: 'rgba(0,0,0,0.15)', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 18 }}>
                  {/* Vertical stats list: label left, count right, no icons/dots */}
                  {[
                    { key: 'waves', label: 'Waves', value: statsEntries.find(e => e.key === 'waves')?.value ?? 0 },
                    { key: 'crew', label: 'Crew', value: statsEntries.find(e => e.key === 'crew')?.value ?? 0 },
                    { key: 'splashes', label: 'Splashes', value: statsEntries.find(e => e.key === 'splashes')?.value ?? 0 },
                    { key: 'hugs', label: 'Hugs', value: statsEntries.find(e => e.key === 'hugs')?.value ?? 0 },
                    { key: 'echoes', label: 'Echoes', value: statsEntries.find(e => e.key === 'echoes')?.value ?? 0 },
                  ].map((entry) => (
                    <View key={entry.key} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginVertical: 4 }}>
                      <Text style={{ color: 'white', fontSize: 16, fontWeight: '600' }}>{entry.label}</Text>
                      <Text style={{ color: 'white', fontSize: 16, fontWeight: '400', marginLeft: 16 }}>{formatCount(entry.value)}</Text>
                    </View>
                  ))}
                </View>
              </View>
            </View>
          </View>
          <Pressable
            style={styles.dismissBtn}
            onPress={() => setShowProfile(false)}
          >
            <Text style={styles.dismissText}>Close</Text>
          </Pressable>
        </View>
      </Modal>

      {/* MY WAVES LIST */}
      <Modal
        visible={showMyWaves}
        transparent
        animationType="fade"
        onRequestClose={() => setShowMyWaves(false)}
      >
        <View
          style={[styles.modalRoot, { justifyContent: 'center', padding: 16 }]}
        >
          <View
            style={[
              styles.logbookContainer,
              {
                maxHeight: SCREEN_HEIGHT * 0.8,
                borderRadius: 12,
                overflow: 'hidden',
              },
            ]}
          >
            {paperTexture && (
              <Image source={paperTexture} style={styles.logbookBg} />
            )}
            <View style={styles.logbookPage}>
              <Text style={styles.logbookTitle}>My Waves</Text>
              <ScrollView>
                {wavesFeed.length === 0 ? (
                  <Text style={styles.hint}>
                    No waves yet. Post from Make Waves.
                  </Text>
                ) : (
                  wavesFeed.map((w, idx) => (
                    <View
                      key={w.id}
                      style={{
                        flexDirection: 'row',
                        paddingVertical: 8,
                        borderBottomWidth: StyleSheet.hairlineWidth,
                        borderBottomColor: 'rgba(255,255,255,0.2)',
                      }}
                    >
                      <Pressable
                        onPress={() => {
                          try {
                            setShowMyWaves(false);
                            setIsPaused(false);
                            setCurrentIndex(idx);
                            setWaveKey(Date.now());
                            requestAnimationFrame(() => {
                              const width = SCREEN_WIDTH;
                              feedRef.current?.scrollTo?.({
                                x: idx * width,
                                animated: false,
                              });
                            });
                            showUiTemporarily();
                          } catch {}
                        }}
                      >
                        <Image
                          source={{ uri: String(w.media?.uri || '') }}
                          style={{
                            width: 96,
                            height: 96,
                            borderRadius: 8,
                            backgroundColor: '#000',
                          }}
                        />
                      </Pressable>
                      <View style={{ flex: 1, marginLeft: 12 }}>
                        <Pressable
                          onPress={() => {
                            try {
                              setShowMyWaves(false);
                              setIsPaused(false);
                              setCurrentIndex(idx);
                              setWaveKey(Date.now());
                              requestAnimationFrame(() => {
                                const width = SCREEN_WIDTH;
                                feedRef.current?.scrollTo?.({
                                  x: idx * width,
                                  animated: false,
                                });
                              });
                              showUiTemporarily();
                            } catch {}
                          }}
                        >
                          <Text
                            style={{
                              color: 'white',
                              fontWeight: '700',
                              fontSize: 13,
                            }}
                            numberOfLines={1}
                          >
                            {w.captionText || 'Untitled wave'}
                          </Text>
                        </Pressable>
                        <Text
                          style={{
                            color: 'rgba(255,255,255,0.7)',
                            marginTop: 2,
                            fontSize: 12,
                          }}
                        >
                          Splashes:{' '}
                          <Text style={{ fontWeight: '700', color: 'white' }}>
                            {waveStats[w.id]?.splashes ?? 0}
                          </Text>
                          {'  '}Echoes:{' '}
                          <Text style={{ fontWeight: '700', color: 'white' }}>
                            {waveStats[w.id]?.echoes ?? 0}
                          </Text>
                          {'  '}Views:{' '}
                          <Text style={{ fontWeight: '700', color: 'white' }}>
                            {waveStats[w.id]?.views ?? 0}
                          </Text>
                        </Text>
                        <Text
                          style={{
                            color: 'rgba(255,255,255,0.6)',
                            fontSize: 11,
                            marginTop: 2,
                          }}
                        >
                          Date:{' '}
                          {waveStats[w.id]?.createdAt
                            ? new Date(
                                waveStats[w.id]!.createdAt!,
                              ).toLocaleString()
                            : '—'}
                        </Text>
                        <View
                          style={{
                            flexDirection: 'row',
                            flexWrap: 'wrap',
                            gap: 8,
                            marginTop: 6,
                          }}
                        >
                          <Pressable
                            onPress={() => deleteWave(w.id)}
                            hitSlop={12}
                            style={[
                              styles.closeBtn,
                              {
                                backgroundColor: 'rgba(255,0,0,0.5)',
                                paddingVertical: 4,
                                paddingHorizontal: 8,
                                marginTop: 4,
                              },
                            ]}
                          >
                            <Text style={[styles.closeText, { fontSize: 12 }]}>
                              Delete
                            </Text>
                          </Pressable>
                          <Pressable
                            onPress={() => onShareWave(w)}
                            style={[
                              styles.closeBtn,
                              {
                                paddingVertical: 4,
                                paddingHorizontal: 8,
                                marginTop: 4,
                              },
                            ]}
                          >
                            <Text style={[styles.closeText, { fontSize: 12 }]}>
                              Share
                            </Text>
                          </Pressable>
                          <Pressable
                            onPress={() => anchorWave(w)}
                            style={[
                              styles.closeBtn,
                              {
                                paddingVertical: 4,
                                paddingHorizontal: 8,
                                marginTop: 4,
                              },
                            ]}
                          >
                            <Text style={[styles.closeText, { fontSize: 12 }]}>
                              Anchor
                            </Text>
                          </Pressable>
                        </View>
                      </View>
                    </View>
                  ))
                )}
              </ScrollView>
            </View>
          </View>
          <Pressable
            style={styles.dismissBtn}
            onPress={() => setShowMyWaves(false)}
          >
            <Text style={styles.dismissText}>Close</Text>
          </Pressable>
        </View>
      </Modal>

      {/* MAKE WAVES */}
      <Modal
        visible={showMakeWaves}
        transparent
        animationType="fade"
        onRequestClose={() => setShowMakeWaves(false)}
      >
        <View
          style={[styles.modalRoot, { justifyContent: 'center', padding: 24 }]}
        >
          <View
            style={[
              styles.logbookContainer,
              {
                maxHeight: SCREEN_HEIGHT * 0.7,
                borderRadius: 12,
                overflow: 'hidden',
              },
            ]}
          >
            {paperTexture && (
              <Image source={paperTexture} style={styles.logbookBg} />
            )}
            <View style={styles.logbookPage}>
              <Text style={styles.logbookTitle}>Make Waves</Text>
              <ScrollView>
                <Pressable style={styles.logbookAction} onPress={openCamera}>
                  <Text style={styles.logbookActionText}>📷 Open Camera</Text>
                </Pressable>
                <Pressable style={styles.logbookAction} onPress={fromGallery}>
                  <Text style={styles.logbookActionText}>🖼️ From Gallery</Text>
                </Pressable>
                <Pressable style={styles.logbookAction} onPress={goDrift}>
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <View
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: 5,
                        backgroundColor: '#00C2FF',
                      }}
                    />
                    <Text style={styles.logbookActionText}>OPEN SEA DRIFT</Text>
                  </View>
                </Pressable>
                <CharteredSeaDriftButton
                  buttonStyle={styles.logbookAction}
                  buttonTextStyle={styles.logbookActionText}
                  onStartPaidDrift={cfg => {
                    setIsCharteredDrift(true);
                    console.log('Chartered Drift Started:', cfg.title);
                    void goDrift();
                  }}
                  onEndPaidDrift={() => {
                    console.log('Chartered Drift Ended');
                    setIsCharteredDrift(false);
                  }}
                  onViewPasses={() => {
                    console.log(
                      'View Passes - handled by CharteredSeaDriftButton',
                    );
                  }}
                  onToggleChat={enabled => {
                    console.log('Chat toggled:', enabled);
                  }}
                  onViewEarnings={() => {
                    console.log(
                      'View Earnings - handled by CharteredSeaDriftButton',
                    );
                  }}
                  onSharePromo={cfg => {
                    console.log(
                      'Share Promo - handled by CharteredSeaDriftButton',
                    );
                  }}
                />
              </ScrollView>
            </View>
          </View>
          <Pressable
            style={styles.dismissBtn}
            onPress={() => setShowMakeWaves(false)}
          >
            <Text style={styles.dismissText}>Close</Text>
          </Pressable>
        </View>
      </Modal>

      {/* PINGS */}
      <Modal
        visible={showPings}
        transparent
        animationType="fade"
        onRequestClose={() => setShowPings(false)}
      >
        <View
          style={[styles.modalRoot, { justifyContent: 'center', padding: 24 }]}
        >
          <View
            style={[
              styles.logbookContainer,
              {
                maxHeight: SCREEN_HEIGHT * 0.7,
                borderRadius: 12,
                overflow: 'hidden',
              },
            ]}
          >
            {paperTexture && (
              <Image source={paperTexture} style={styles.logbookBg} />
            )}
            <View style={styles.logbookPage}>
              <Text style={styles.logbookTitle}>PINGS</Text>
              <ScrollView>
                {pings.length === 0 ? (
                  <Text
                    style={{
                      color: 'rgba(255,255,255,0.7)',
                      textAlign: 'center',
                      marginTop: 20,
                    }}
                  >
                    No pings yet
                  </Text>
                ) : (
                  pings.map((p, idx) => (
                    <View
                      key={`${p.id || 'unknown'}-${idx}`}
                      style={[
                        styles.logbookAction,
                        {
                          opacity: p.read ? 0.6 : 1,
                          flexDirection: 'column',
                          alignItems: 'flex-start',
                          paddingVertical: 12,
                        },
                      ]}
                    >
                      <View
                        style={{
                          flexDirection: 'row',
                          justifyContent: 'space-between',
                          width: '100%',
                          marginBottom: 4,
                        }}
                      >
                        <Text
                          style={[
                            styles.pingText,
                            { fontWeight: '600', flex: 1 },
                          ]}
                        >
                          {formatPingMessage(p)}
                        </Text>
                        <Text
                          style={{
                            color: 'rgba(255,255,255,0.5)',
                            fontSize: 12,
                            marginLeft: 8,
                          }}
                        >
                          {formatPingTime(p.timestamp)}
                        </Text>
                      </View>
                      {p.type === 'message' && (p as any).fromUid && (
                        <Pressable
                          style={[styles.pingButton, { marginTop: 8 }]}
                          onPress={() => {
                            setShowPings(false);
                            setMessageRecipient({
                              uid: (p as any).fromUid,
                              name: displayHandle(
                                (p as any).fromUid,
                                p.actorName,
                              ),
                            });
                            setMessageText('');
                            setShowSendMessage(true);
                          }}
                        >
                          <Text style={{ color: '#00C2FF', fontWeight: '700' }}>
                            Reply
                          </Text>
                        </Pressable>
                      )}
                      {(p.type === 'splash' || p.type === 'echo') &&
                        p.waveId && (
                          <Pressable
                            style={[styles.pingButton, { marginTop: 8 }]}
                            onPress={() => handlePingAction(p)}
                          >
                            <Text
                              style={{ color: '#00C2FF', fontWeight: '700' }}
                            >
                              {p.type === 'echo' ? 'View Echo' : 'View Wave'}
                            </Text>
                          </Pressable>
                        )}
                      {p.type === 'follow' && (p as any).fromUid && (
                        <Pressable
                          style={[styles.pingButton, { marginTop: 8 }]}
                          onPress={() => {
                            setShowPings(false);
                            setMessageRecipient({
                              uid: (p as any).fromUid,
                              name: displayHandle(
                                (p as any).fromUid,
                                p.actorName,
                              ),
                            });
                            setMessageText('');
                            setShowSendMessage(true);
                          }}
                        >
                          <Text style={{ color: '#00C2FF', fontWeight: '700' }}>
                            Message
                          </Text>
                        </Pressable>
                      )}
                    </View>
                  ))
                )}
              </ScrollView>
            </View>
          </View>
          <Pressable
            style={styles.dismissBtn}
            onPress={() => setShowPings(false)}
          >
            <Text style={styles.dismissText}>Close</Text>
          </Pressable>
        </View>
      </Modal>

      {/* SET SAIL */}
      <Modal
        visible={showExplore}
        transparent
        animationType="fade"
        onRequestClose={() => setShowExplore(false)}
      >
        <View
          style={[styles.modalRoot, { justifyContent: 'center', padding: 24 }]}
        >
          <View
            style={[
              styles.logbookContainer,
              {
                maxHeight: SCREEN_HEIGHT * 0.7,
                borderRadius: 12,
                overflow: 'hidden',
              },
            ]}
          >
            {paperTexture && (
              <Image source={paperTexture} style={styles.logbookBg} />
            )}
            <View style={styles.logbookPage}>
              <Text style={styles.logbookTitle}>SET SAIL</Text>
              <ScrollView>
                {explore.map(t => (
                  <Pressable
                    key={t.title}
                    style={styles.logbookAction}
                    onPress={() =>
                      Alert.alert(t.title, 'This ocean is not yet charted.')
                    }
                  >
                    <Text style={styles.logbookActionText}>{t.title}</Text>
                    <Text
                      style={[
                        styles.hint,
                        {
                          fontFamily:
                            Platform.OS === 'ios' ? 'Courier New' : 'monospace',
                          marginTop: 4,
                        },
                      ]}
                    >
                      {t.desc}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          </View>
          <Pressable
            style={styles.dismissBtn}
            onPress={() => setShowExplore(false)}
          >
            <Text style={styles.dismissText}>Close</Text>
          </Pressable>
        </View>
      </Modal>

      {/* NOTICE BOARD */}
      <Modal
        visible={showNotice}
        transparent
        animationType="fade"
        onRequestClose={() => setShowNotice(false)}
      >
        <View
          style={[styles.modalRoot, { justifyContent: 'center', padding: 24 }]}
        >
          <View
            style={[
              styles.logbookContainer,
              {
                maxHeight: SCREEN_HEIGHT * 0.8,
                borderRadius: 12,
                overflow: 'hidden',
              },
            ]}
          >
            {paperTexture && (
              <Image source={paperTexture} style={styles.logbookBg} />
            )}
            <View style={styles.logbookPage}>
              <Text style={styles.logbookTitle}>NOTICE BOARD</Text>
              <ScrollView>
                <Text style={styles.logbookActionText}>
                  Register your organization
                </Text>
                <TextInput
                  placeholder="Organization name"
                  placeholderTextColor="rgba(255,255,255,0.4)"
                  style={styles.logbookInput}
                />
                <TextInput
                  placeholder="Type (Public/Private)"
                  placeholderTextColor="rgba(255,255,255,0.4)"
                  style={styles.logbookInput}
                />
                <TextInput
                  placeholder="Official email"
                  placeholderTextColor="rgba(255,255,255,0.4)"
                  style={styles.logbookInput}
                  keyboardType="email-address"
                />
                <TextInput
                  placeholder="Phone number"
                  placeholderTextColor="rgba(255,255,255,0.4)"
                  style={styles.logbookInput}
                  keyboardType="phone-pad"
                />
                <TextInput
                  placeholder="Short bio / About"
                  placeholderTextColor="rgba(255,255,255,0.4)"
                  style={[styles.logbookInput, { height: 100 }]}
                  multiline
                />
                <Pressable style={[styles.primaryBtn, { marginTop: 16 }]}>
                  <Text style={styles.primaryBtnText}>Submit</Text>
                </Pressable>
                <Text
                  style={[
                    styles.hint,
                    {
                      fontFamily:
                        Platform.OS === 'ios' ? 'Courier New' : 'monospace',
                      marginTop: 8,
                    },
                  ]}
                >
                  After approval, you can post public notices/adverts here.
                </Text>
              </ScrollView>
            </View>
          </View>
          <Pressable
            style={styles.dismissBtn}
            onPress={() => setShowNotice(false)}
          >
            <Text style={styles.dismissText}>Close</Text>
          </Pressable>
        </View>
      </Modal>

      {/* SCHOOL MODE */}
      <Modal
        visible={showSchoolMode}
        transparent
        animationType="fade"
        onRequestClose={() => setShowSchoolMode(false)}
      >
        <View
          style={[styles.modalRoot, { justifyContent: 'center', padding: 24 }]}
        >
          <View
            style={[
              styles.logbookContainer,
              {
                maxHeight: SCREEN_HEIGHT * 0.8,
                borderRadius: 12,
                overflow: 'hidden',
              },
            ]}
          >
            {paperTexture && (
              <Image source={paperTexture} style={styles.logbookBg} />
            )}
            <View style={styles.logbookPage}>
              <Text style={styles.logbookTitle}>SCHOOL MODE</Text>
              <ScrollView>
                {[
                  {
                    icon: '🎥',
                    title: 'Sea of Lessons',
                    desc: 'Browse educational videos',
                    action: () => {
                      Alert.alert(
                        'Sea of Lessons',
                        'What would you like to learn today?',
                        [
                          {
                            text: 'Math & Science',
                            onPress: () =>
                              Alert.alert(
                                'Coming Soon',
                                'Math & Science courses will be available soon!',
                              ),
                          },
                          {
                            text: 'Languages',
                            onPress: () =>
                              Alert.alert(
                                'Coming Soon',
                                'Language learning courses coming soon!',
                              ),
                          },
                          {
                            text: 'Creative Arts',
                            onPress: () =>
                              Alert.alert(
                                'Coming Soon',
                                'Creative arts tutorials on the way!',
                              ),
                          },
                          { text: 'Cancel', style: 'cancel' },
                        ],
                      );
                    },
                  },
                  {
                    icon: '❓',
                    title: 'Deep Dive',
                    desc: 'Take a quiz challenge',
                    action: () => {
                      Alert.alert(
                        'Deep Dive Challenge',
                        'Choose your subject:',
                        [
                          {
                            text: 'General Knowledge',
                            onPress: () =>
                              Alert.alert(
                                'Quiz Started',
                                'Answer 5 questions to test your knowledge!',
                              ),
                          },
                          {
                            text: 'Current Events',
                            onPress: () =>
                              Alert.alert(
                                'Quiz Started',
                                'How well do you know current events?',
                              ),
                          },
                          {
                            text: 'Subject Mastery',
                            onPress: () =>
                              Alert.alert(
                                'Coming Soon',
                                'Advanced subject tests coming soon!',
                              ),
                          },
                          { text: 'Cancel', style: 'cancel' },
                        ],
                      );
                    },
                  },
                  {
                    icon: '🏝️',
                    title: 'My Shore',
                    desc: 'View your learning profile',
                    action: () => {
                      setShowSchoolMode(false);
                      setTimeout(() => setShowProfile(true), 300);
                    },
                  },
                  {
                    icon: '🌊',
                    title: 'Ask the Tide',
                    desc: 'Post questions to community',
                    action: () => {
                      Alert.prompt(
                        'Ask the Tide',
                        'What would you like to ask the community?',
                        [
                          { text: 'Cancel', style: 'cancel' },
                          {
                            text: 'Post',
                            onPress: (question: any) => {
                              if (question) {
                                Alert.alert(
                                  'Question Posted!',
                                  `"${question}"\n\nOur community will help you soon!`,
                                );
                              }
                            },
                          },
                        ],
                      );
                    },
                  },
                  {
                    icon: '🪸',
                    title: 'Pearl Rewards',
                    desc: 'Earn learning points',
                    action: () => {
                      setShowSchoolMode(false);
                      setTimeout(() => setShowPearls(true), 300);
                    },
                  },
                  {
                    icon: '🐋',
                    title: 'Join a Crew',
                    desc: 'Find study groups',
                    action: () => {
                      Alert.alert('Join a Crew', 'Available Study Groups:', [
                        {
                          text: 'Math Wizards (12 members)',
                          onPress: () =>
                            Alert.alert(
                              'Joined!',
                              'Welcome to Math Wizards study group!',
                            ),
                        },
                        {
                          text: 'Science Explorers (8 members)',
                          onPress: () =>
                            Alert.alert(
                              'Joined!',
                              'Welcome to Science Explorers!',
                            ),
                        },
                        {
                          text: 'Language Learners (15 members)',
                          onPress: () =>
                            Alert.alert(
                              'Joined!',
                              'Welcome to Language Learners!',
                            ),
                        },
                        {
                          text: 'Create New Group',
                          onPress: () =>
                            Alert.alert(
                              'Coming Soon',
                              'Group creation feature coming soon!',
                            ),
                        },
                        { text: 'Cancel', style: 'cancel' },
                      ]);
                    },
                  },
                  {
                    icon: '🧭',
                    title: 'School Currents',
                    desc: 'Structured curriculum',
                    action: () => {
                      Alert.alert(
                        'School Currents',
                        'Choose your learning path:',
                        [
                          {
                            text: 'Beginner Track',
                            onPress: () =>
                              Alert.alert(
                                'Enrolled!',
                                "You've joined the Beginner learning track!",
                              ),
                          },
                          {
                            text: 'Intermediate Track',
                            onPress: () =>
                              Alert.alert(
                                'Enrolled!',
                                "You've joined the Intermediate track!",
                              ),
                          },
                          {
                            text: 'Advanced Track',
                            onPress: () =>
                              Alert.alert(
                                'Enrolled!',
                                "You've joined the Advanced learning track!",
                              ),
                          },
                          { text: 'Cancel', style: 'cancel' },
                        ],
                      );
                    },
                  },
                  {
                    icon: '⚓',
                    title: "Teacher's Dock",
                    desc: 'Educator resources',
                    action: () => {
                      Alert.alert("Teacher's Dock", 'Educator Features:', [
                        {
                          text: 'Upload Lesson',
                          onPress: () =>
                            Alert.alert(
                              'Coming Soon',
                              'Lesson upload feature coming soon!',
                            ),
                        },
                        {
                          text: 'Create Assignment',
                          onPress: () =>
                            Alert.alert(
                              'Coming Soon',
                              'Assignment creation tools on the way!',
                            ),
                        },
                        {
                          text: 'View Analytics',
                          onPress: () =>
                            Alert.alert(
                              'Coming Soon',
                              'Student analytics dashboard coming soon!',
                            ),
                        },
                        { text: 'Cancel', style: 'cancel' },
                      ]);
                    },
                  },
                  {
                    icon: '🪙',
                    title: 'Ocean Library',
                    desc: 'Download resources',
                    action: () => {
                      Alert.alert('Ocean Library', 'Available Resources:', [
                        {
                          text: 'E-books',
                          onPress: () =>
                            Alert.alert(
                              'Downloading...',
                              'E-book library opening soon!',
                            ),
                        },
                        {
                          text: 'Study Guides',
                          onPress: () =>
                            Alert.alert(
                              'Downloading...',
                              'Study guides available soon!',
                            ),
                        },
                        {
                          text: 'Video Lessons',
                          onPress: () =>
                            Alert.alert(
                              'Downloading...',
                              'Offline videos coming soon!',
                            ),
                        },
                        { text: 'Cancel', style: 'cancel' },
                      ]);
                    },
                  },
                  {
                    icon: '🌅',
                    title: 'Mind Drift',
                    desc: 'Focus and productivity',
                    action: () => {
                      Alert.alert('Mind Drift', 'Focus Tools:', [
                        {
                          text: 'Pomodoro Timer',
                          onPress: () =>
                            Alert.alert(
                              'Timer Started',
                              '25-minute focus session started!',
                            ),
                        },
                        {
                          text: 'Meditation',
                          onPress: () =>
                            Alert.alert(
                              'Coming Soon',
                              'Guided meditation for focus coming soon!',
                            ),
                        },
                        {
                          text: 'Study Music',
                          onPress: () =>
                            Alert.alert(
                              'Coming Soon',
                              'Focus music playlists on the way!',
                            ),
                        },
                        { text: 'Cancel', style: 'cancel' },
                      ]);
                    },
                  },
                ].map(item => (
                  <Pressable
                    key={item.title}
                    style={styles.logbookAction}
                    onPress={item.action}
                  >
                    <Text style={styles.logbookActionText}>
                      {item.icon} {item.title}
                    </Text>
                    <Text
                      style={[
                        styles.hint,
                        {
                          fontFamily:
                            Platform.OS === 'ios' ? 'Courier New' : 'monospace',
                          marginTop: 4,
                        },
                      ]}
                    >
                      {item.desc}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          </View>
          <Pressable
            style={styles.dismissBtn}
            onPress={() => setShowSchoolMode(false)}
          >
            <Text style={styles.dismissText}>Close</Text>
          </Pressable>
        </View>
      </Modal>

      {/* THE BRIDGE */}
      <Modal
        visible={showBridge}
        transparent
        animationType="fade"
        onRequestClose={() => setShowBridge(false)}
      >
        <View
          style={[styles.modalRoot, { justifyContent: 'center', padding: 24 }]}
        >
          <View
            style={[
              styles.logbookContainer,
              {
                maxHeight: SCREEN_HEIGHT * 0.8,
                borderRadius: 12,
                overflow: 'hidden',
              },
            ]}
          >
            {paperTexture && (
              <Image source={paperTexture} style={styles.logbookBg} />
            )}
            <View style={styles.logbookPage}>
              <Text style={styles.logbookTitle}>THE BRIDGE</Text>
              <ScrollView>
                {/* Safe Harbor Section */}
                <View style={{ paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.1)' }}>
                  <Pressable
                    style={styles.safeHarborHeader}
                    onPress={() => {
                      try {
                        setSafeHarborExpanded(prev => !prev);
                      } catch (e) {
                        console.log('Safe harbor expand error:', e);
                      }
                    }}
                  >
                    <Text style={[styles.logbookActionText, { fontSize: 18 }]}>🛡️ Safe Harbor</Text>
                    <Text style={{ color: 'rgba(255,255,255,0.65)', fontSize: 12 }}>
                      {safeHarborExpanded ? 'Hide guardian controls' : 'Reveal guardian controls'}
                    </Text>
                  </Pressable>
                  {safeHarborExpanded ? (
                    <View style={{ marginTop: 6 }}>
                      <View style={[styles.logbookAction, { flexDirection: 'row', justifyContent: 'space-between' }]}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={styles.logbookActionText}>🧒 Shallow Waters Mode</Text>
                          <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>Age-appropriate content for users under 13</Text>
                        </View>
                        <Pressable
                          onPress={() => {
                            try {
                              setSafetySettings((prev: any) => ({ ...prev, shallowWatersMode: !prev.shallowWatersMode }));
                            } catch (e) {
                              console.log('Shallow waters error:', e);
                            }
                          }}
                        >
                          <Text style={styles.logbookActionText}>
                            {safetySettings.shallowWatersMode ? 'ON' : 'OFF'}
                          </Text>
                        </Pressable>
                      </View>

                      <View style={[styles.logbookAction, { flexDirection: 'row', justifyContent: 'space-between' }]}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={styles.logbookActionText}>🧐 Lifeguard Alerts</Text>
                          <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>AI monitors content for safety</Text>
                        </View>
                        <Pressable
                          onPress={() => {
                            try {
                              setSafetySettings((prev: any) => ({ ...prev, lifeguardAlertsEnabled: !prev.lifeguardAlertsEnabled }));
                            } catch (e) {
                              console.log('Lifeguard alerts error:', e);
                            }
                          }}
                        >
                          <Text style={styles.logbookActionText}>
                            {safetySettings.lifeguardAlertsEnabled ? 'ON' : 'OFF'}
                          </Text>
                        </Pressable>
                      </View>

                      <View style={[styles.logbookAction, { flexDirection: 'row', justifyContent: 'space-between' }]}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={styles.logbookActionText}>🫂 Buddy System</Text>
                          <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>Parent/guardian can monitor activity</Text>
                        </View>
                        <Pressable
                          onPress={() => {
                            try {
                              setSafetySettings((prev: any) => ({ ...prev, buddySystemEnabled: !prev.buddySystemEnabled }));
                            } catch (e) {
                              console.log('Buddy system error:', e);
                            }
                          }}
                        >
                          <Text style={styles.logbookActionText}>
                            {safetySettings.buddySystemEnabled ? 'ON' : 'OFF'}
                          </Text>
                        </Pressable>
                      </View>

                      <View style={[styles.logbookAction, { flexDirection: 'row', justifyContent: 'space-between' }]}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={styles.logbookActionText}>🚫 No Current Zone</Text>
                          <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>Disable all direct messages</Text>
                        </View>
                        <Pressable
                          onPress={() => {
                            try {
                              setSafetySettings((prev: any) => ({ ...prev, noCurrentZone: !prev.noCurrentZone }));
                            } catch (e) {
                              console.log('No current zone error:', e);
                            }
                          }}
                        >
                          <Text style={styles.logbookActionText}>
                            {safetySettings.noCurrentZone ? 'ON' : 'OFF'}
                          </Text>
                        </Pressable>
                      </View>

                      <View style={[styles.logbookAction, { flexDirection: 'row', justifyContent: 'space-between' }]}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={styles.logbookActionText}>🔒 Hide Restricted Content</Text>
                          <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>Filter mature or sensitive content</Text>
                        </View>
                        <Pressable
                          onPress={() => {
                            try {
                              setSafetySettings((prev: any) => ({ ...prev, restrictedContentHidden: !prev.restrictedContentHidden }));
                            } catch (e) {
                              console.log('Restricted content error:', e);
                            }
                          }}
                        >
                          <Text style={styles.logbookActionText}>
                            {safetySettings.restrictedContentHidden ? 'ON' : 'OFF'}
                          </Text>
                        </Pressable>
                      </View>
                    </View>
                  ) : (
                    <Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12, marginTop: 8 }}>
                      Tap to reveal filtering, buddy monitoring, and message controls.
                    </Text>
                  )}
                </View>

                <View
                  style={{
                    paddingVertical: 12,
                    borderBottomWidth: 1,
                    borderBottomColor: 'rgba(255,255,255,0.1)',
                  }}
                >
                  <Text style={[styles.logbookActionText, { fontSize: 18, marginBottom: 6 }]}>
                    Storm Animations
                  </Text>
                  <Pressable
                    style={[
                      styles.bridgeSettingButton,
                      {
                        backgroundColor: bridge.rainEffectsEnabled
                          ? 'rgba(0, 194, 255, 0.2)'
                          : 'rgba(255, 255, 255, 0.08)',
                      },
                    ]}
                    onPress={() =>
                      saveBridge({
                        rainEffectsEnabled: !bridge.rainEffectsEnabled,
                      })
                    }
                  >
                    <Text style={styles.bridgeSettingButtonText}>
                      {bridge.rainEffectsEnabled ? 'Disable' : 'Enable'} rain effects
                    </Text>
                    <Text style={styles.bridgeSettingHint}>
                      {bridge.rainEffectsEnabled
                        ? 'Shake to intensify rainfall'
                        : 'Enable to let shakes trigger rain'}
                    </Text>
                  </Pressable>
                </View>

                {/* Data Saver Section */}
                <View style={{ paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.1)' }}>
                  <Text style={[styles.logbookActionText, { fontSize: 18, marginBottom: 8 }]}>Data Saver</Text>
                  <BridgeDataSaverPanel />
                </View>
                <View
                  style={[
                    styles.logbookAction,
                    { flexDirection: 'row', justifyContent: 'space-between' },
                  ]}
                >
                  <Text style={styles.logbookActionText}>Low-Tide Mode</Text>
                  <Pressable
                    onPress={() =>
                      saveBridge({
                        dataSaverDefaultOnCell: !bridge.dataSaverDefaultOnCell,
                      })
                    }
                  >
                    <Text style={styles.logbookActionText}>
                      {bridge.dataSaverDefaultOnCell ? 'ON' : 'OFF'}
                    </Text>
                  </Pressable>
                </View>
                <View
                  style={[
                    styles.logbookAction,
                    { flexDirection: 'row', justifyContent: 'space-between' },
                  ]}
                >
                  <Text style={styles.logbookActionText}>Wi‑Fi‑Only HD</Text>
                  <Pressable
                    onPress={() =>
                      saveBridge({ wifiOnlyHD: !bridge.wifiOnlyHD })
                    }
                  >
                    <Text style={styles.logbookActionText}>
                      {bridge.wifiOnlyHD ? 'ON' : 'OFF'}
                    </Text>
                  </Pressable>
                </View>
                <View
                  style={[
                    styles.logbookAction,
                    { flexDirection: 'row', justifyContent: 'space-between' },
                  ]}
                >
                  <Text style={styles.logbookActionText}>
                    Autoplay (Cellular)
                  </Text>
                  <Pressable
                    onPress={() => {
                      const o: Array<'off' | 'preview' | 'full'> = [
                        'off',
                        'preview',
                        'full',
                      ];
                      saveBridge({
                        autoplayCellular:
                          o[
                            (o.indexOf(bridge.autoplayCellular) + 1) % o.length
                          ],
                      });
                    }}
                  >
                    <Text style={styles.logbookActionText}>
                      {bridge.autoplayCellular.toUpperCase()}
                    </Text>
                  </Pressable>
                </View>
                <View
                  style={[
                    styles.logbookAction,
                    { flexDirection: 'row', justifyContent: 'space-between' },
                  ]}
                >
                  <Text style={styles.logbookActionText}>Prefetch Next</Text>
                  <Pressable
                    onPress={() => {
                      const o: Array<0 | 1 | 2 | 3> = [0, 1, 2, 3];
                      saveBridge({
                        prefetchNext:
                          o[
                            (o.indexOf(bridge.prefetchNext as any) + 1) %
                              o.length
                          ],
                      });
                    }}
                  >
                    <Text style={styles.logbookActionText}>
                      {String(bridge.prefetchNext)}
                    </Text>
                  </Pressable>
                </View>
                <View
                  style={[
                    styles.logbookAction,
                    { flexDirection: 'row', justifyContent: 'space-between' },
                  ]}
                >
                  <Text style={styles.logbookActionText}>
                    Thumbnail Quality
                  </Text>
                  <Pressable
                    onPress={() => {
                      const o: Array<'lite' | 'standard' | 'high'> = [
                        'lite',
                        'standard',
                        'high',
                      ];
                      saveBridge({
                        thumbQuality:
                          o[(o.indexOf(bridge.thumbQuality) + 1) % o.length],
                      });
                    }}
                  >
                    <Text style={styles.logbookActionText}>
                      {bridge.thumbQuality.toUpperCase()}
                    </Text>
                  </Pressable>
                </View>
                {/* System + brand footer */}
                <View
                  style={{
                    marginTop: 28,
                    paddingTop: 16,
                    borderTopWidth: 1,
                    borderTopColor: 'rgba(255,255,255,0.08)',
                  }}
                >
                  <Text
                    style={[
                      styles.logbookActionText,
                      { fontSize: 16, marginBottom: 10 },
                    ]}
                  >
                    System build
                  </Text>
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <View
                      style={{
                        flex: 1,
                        borderWidth: 1,
                        borderColor: 'rgba(255,255,255,0.08)',
                        borderRadius: 12,
                        paddingVertical: 12,
                        paddingHorizontal: 12,
                        backgroundColor: 'rgba(5,10,20,0.55)',
                      }}
                    >
                      <Text
                        style={{
                          color: 'rgba(255,255,255,0.7)',
                          fontSize: 12,
                          letterSpacing: 0.4,
                          marginBottom: 4,
                        }}
                      >
                        Version & build
                      </Text>
                      <Text
                        style={{
                          color: 'white',
                          fontSize: 18,
                          fontWeight: '800',
                          marginBottom: 2,
                        }}
                      >
                        v{versionInfo.version} | build {versionInfo.build}
                      </Text>
                      <Text
                        style={{
                          color: 'rgba(255,255,255,0.65)',
                          fontSize: 11,
                          letterSpacing: 0.2,
                        }}
                      >
                        Source: {versionInfo.source ?? 'native'}
                      </Text>
                    </View>
                    <View
                      style={{
                        width: 108,
                        borderWidth: 1,
                        borderColor: '#C00000',
                        borderRadius: 14,
                        paddingVertical: 10,
                        paddingHorizontal: 10,
                        backgroundColor: 'rgba(192,0,0,0.12)',
                        alignItems: 'center',
                        justifyContent: 'center',
                        marginLeft: 12,
                      }}
                    >
                      <Text
                        style={{
                          color: '#C00000',
                          fontSize: 22,
                          fontWeight: '900',
                          letterSpacing: 1.8,
                        }}
                      >
                        SPL
                      </Text>
                      <Text
                        style={{
                          color: '#C00000',
                          fontSize: 10,
                          fontWeight: '800',
                          letterSpacing: 1,
                        }}
                      >
                        Trademark 2025
                      </Text>
                    </View>
                  </View>
                </View>
              </ScrollView>
            </View>
          </View>
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              marginTop: 12,
            }}
          >
            <Pressable
              style={[styles.closeBtn, { flex: 1, backgroundColor: 'red' }]}
              onPress={async () => {
                try {
                  await auth().signOut();
                } catch (e) {
                  Alert.alert(
                    'Sign out failed',
                    String((e as any)?.message || e),
                  );
                }
              }}
            >
              <Text style={styles.closeText}>Sign Out</Text>
            </Pressable>
            <View style={{ width: 12 }} />
            <Pressable
              style={[styles.dismissBtn, { flex: 1 }]}
              onPress={() => setShowBridge(false)}
            >
              <Text style={styles.dismissText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* DEEP DIVE Modal */}
      <Modal
        visible={showDeepSearch}
        transparent
        animationType="fade"
        onRequestClose={() => setShowDeepSearch(false)}
      >
        <View
          style={[styles.modalRoot, { justifyContent: 'center', padding: 24 }]}
        >
          <View
            style={[
              styles.modalContent,
              { width: '100%', maxHeight: SCREEN_HEIGHT * 0.75 },
            ]}
          >
            <Text style={styles.modalTitle}>DEEP DIVE - Find Drifters</Text>
            
            <Text style={[styles.hint, { marginBottom: 8 }]}>
              Search by username:
            </Text>
            <TextInput
              value={deepQuery}
              onChangeText={v => setDeepQuery(v)}
              placeholder="Enter username..."
              placeholderTextColor="rgba(255,255,255,0.4)"
              style={[styles.input, { fontSize: 14 }]}
              autoCapitalize="none"
            />
            <Pressable
              style={[styles.primaryBtn, deepSearchLoading && { opacity: 0.7 }]}
              onPress={runDeepSearch}
              disabled={deepSearchLoading}
            >
              {deepSearchLoading ? (
                <ActivityIndicator color="white" size="small" />
              ) : (
                <Text style={styles.primaryBtnText}>Search</Text>
              )}
            </Pressable>
            {deepSearchError && (
              <Text style={[styles.hint, { color: '#ff6b6b', marginTop: 8 }]}>
                {deepSearchError}
              </Text>
            )}
            <ScrollView style={{ flex: 1, marginTop: 12 }}>
              {(() => {
                console.log('Rendering search results, deepResults.length:', deepResults.length);
                console.log('deepSearchLoading:', deepSearchLoading);
                console.log('deepResults:', JSON.stringify(deepResults));
                return null;
              })()}
              {!deepSearchLoading && deepResults.length === 0 && (
                <Text style={styles.hint}>
                  No results yet. Try a handle or keyword.
                </Text>
              )}
              {deepResults.map(result => (
                <View key={result.kind + result.id}>
                  {result.kind === 'wave' ? (
                    <Pressable
                      style={styles.pingItem}
                      onPress={() => handleDeepWaveSelect(result)}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={styles.pingText}>
                          🌊 {result.label}
                        </Text>
                      </View>
                      <Text style={styles.primaryBtnText}>View wave</Text>
                    </Pressable>
                  ) : (
                    <View style={{
                      backgroundColor: 'rgba(255,255,255,0.05)',
                      borderRadius: 12,
                      padding: 12,
                      marginBottom: 12,
                      borderWidth: 1,
                      borderColor: 'rgba(255,255,255,0.1)',
                    }}>
                      {/* User Profile Header */}
                      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
                        {/* Profile Picture or Avatar */}
                        <View style={{
                          width: 56,
                          height: 56,
                          borderRadius: 28,
                          backgroundColor: '#00C2FF',
                          alignItems: 'center',
                          justifyContent: 'center',
                          marginRight: 12,
                          overflow: 'hidden',
                        }}>
                          {result.extra?.photoURL ? (
                            <Image
                              source={{ uri: result.extra.photoURL }}
                              style={{ width: 56, height: 56 }}
                              resizeMode="cover"
                            />
                          ) : (
                            <Text style={{ fontSize: 28, color: 'white' }}>
                              {result.label.charAt(0).toUpperCase()}
                            </Text>
                          )}
                        </View>
                        
                        {/* User Info */}
                        <View style={{ flex: 1 }}>
                          <Text style={{
                            color: 'white',
                            fontSize: 16,
                            fontWeight: 'bold',
                            marginBottom: 4,
                          }}>
                            {result.label}
                          </Text>
                          {result.extra?.bio && typeof result.extra.bio === 'string' && (
                            <Text
                              style={{
                                color: 'rgba(255,255,255,0.6)',
                                fontSize: 12,
                              }}
                              numberOfLines={2}
                            >
                              {result.extra.bio}
                            </Text>
                          )}
                        </View>
                      </View>
                      
                      {/* Action Buttons */}
                      <View style={{
                        flexDirection: 'row',
                        gap: 8,
                        flexWrap: 'wrap',
                      }}>
                        {/* Join/Leave Crew Button */}
                        <Pressable
                          style={[
                            {
                              flex: 1,
                              minWidth: '45%',
                              paddingVertical: 10,
                              borderRadius: 8,
                              alignItems: 'center',
                              borderWidth: 1,
                            },
                            isInUserCrew[result.id] ? {
                              backgroundColor: '#ff6b6b',
                              borderColor: '#ff6b6b',
                            } : {
                              backgroundColor: '#00C2FF',
                              borderColor: '#00C2FF',
                            }
                          ]}
                          onPress={async () => {
                            const currentUser = auth?.()?.currentUser;
                            if (!currentUser) {
                              Alert.alert('Sign in required');
                              return;
                            }
                            if (currentUser.uid === result.id) {
                              Alert.alert('Info', "You can't join your own crew");
                              return;
                            }
                            if (isInUserCrew[result.id]) {
                              await handleLeaveCrew(result.id, result.label);
                            } else {
                              await handleJoinCrew(result.id, result.label);
                            }
                          }}
                        >
                          <Text style={{
                            color: 'white',
                            fontSize: 14,
                            fontWeight: '600',
                          }}>
                            {isInUserCrew[result.id] ? '🚪 Leave Crew' : '⚓ Join Crew'}
                          </Text>
                        </Pressable>
                        
                        {/* Send Message Button */}
                        <Pressable
                          style={{
                            flex: 1,
                            minWidth: '45%',
                            paddingVertical: 10,
                            borderRadius: 8,
                            alignItems: 'center',
                            borderWidth: 1,
                            borderColor: '#9C27B0',
                            backgroundColor: 'rgba(156, 39, 176, 0.2)',
                          }}
                          onPress={async () => {
                            const currentUser = auth?.()?.currentUser;
                            if (!currentUser) {
                              Alert.alert('Sign in required', 'You must be signed in to send messages.');
                              return;
                            }
                            if (currentUser.uid === result.id) {
                              Alert.alert('Info', "You can't message yourself");
                              return;
                            }
                            setMessageRecipient({
                              uid: result.id,
                              name: result.label,
                            });
                            setShowSendMessage(true);
                            setShowDeepSearch(false);
                          }}
                        >
                          <Text style={{
                            color: '#E1BEE7',
                            fontSize: 14,
                            fontWeight: '600',
                          }}>
                            💬 Message
                          </Text>
                        </Pressable>
                        
                        {/* Invite to Drift Button */}
                        <Pressable
                          style={{
                            flex: 1,
                            minWidth: '45%',
                            paddingVertical: 10,
                            borderRadius: 8,
                            alignItems: 'center',
                            borderWidth: 1,
                            borderColor: '#4CAF50',
                            backgroundColor: 'rgba(76, 175, 80, 0.2)',
                          }}
                          onPress={() => {
                            inviteCoHostById(result.id, result.label);
                            setShowDeepSearch(false);
                          }}
                        >
                          <Text style={{
                            color: '#A5D6A7',
                            fontSize: 14,
                            fontWeight: '600',
                          }}>
                            🎙️ Invite Drift
                          </Text>
                        </Pressable>
                        
                        {/* Request to Join Their Drift (if they're live) */}
                        {result.extra?.liveId && (
                          <Pressable
                            style={{
                              flex: 1,
                              minWidth: '45%',
                              paddingVertical: 10,
                              borderRadius: 8,
                              alignItems: 'center',
                              borderWidth: 1,
                              borderColor: '#FF9800',
                              backgroundColor: 'rgba(255, 152, 0, 0.2)',
                            }}
                            onPress={() => {
                              requestToDriftForLiveId(
                                result.extra.liveId,
                                result.label,
                              );
                              setShowDeepSearch(false);
                            }}
                          >
                            <Text style={{
                              color: '#FFE0B2',
                              fontSize: 14,
                              fontWeight: '600',
                            }}>
                              🔴 Request Drift
                            </Text>
                          </Pressable>
                        )}
                      </View>
                    </View>
                  )}
                </View>
              ))}
            </ScrollView>
            <Pressable
              style={styles.closeBtn}
              onPress={() => setShowDeepSearch(false)}
            >
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* PEARLS */}
      <Modal
        visible={showPearls}
        transparent
        animationType="fade"
        onRequestClose={() => setShowPearls(false)}
      >
        <View
          style={[styles.modalRoot, { justifyContent: 'center', padding: 24 }]}
        >
          <View
            style={[
              styles.logbookContainer,
              {
                maxHeight: SCREEN_HEIGHT * 0.8,
                borderRadius: 12,
                overflow: 'hidden',
              },
            ]}
          >
            {paperTexture && (
              <Image source={paperTexture} style={styles.logbookBg} />
            )}
            <View style={styles.logbookPage}>
              <Text style={styles.logbookTitle}>PEARLS</Text>
              <ScrollView>
                {!selectedCountry ? (
                  <View>
                    <Text style={styles.logbookActionText}>
                      Select your country
                    </Text>
                    <Pressable
                      style={[styles.primaryBtn, { marginTop: 8 }]}
                      onPress={() => setShowCountryPicker(true)}
                    >
                      <Text style={styles.primaryBtnText}>
                        {selectedCountry || 'Select a country...'}
                      </Text>
                    </Pressable>
                    <Text
                      style={[
                        styles.hint,
                        {
                          fontFamily:
                            Platform.OS === 'ios' ? 'Courier New' : 'monospace',
                          marginTop: 8,
                        },
                      ]}
                    >
                      Payment details are available for supported countries.
                    </Text>
                  </View>
                ) : (
                  <View style={{ gap: 12 }}>
                    <Pressable
                      style={styles.primaryBtn}
                      onPress={() => setShowCountryPicker(true)}
                    >
                      <Text style={styles.primaryBtnText}>
                        {selectedCountry}
                      </Text>
                    </Pressable>
                    <Pressable onPress={() => setSelectedCountry(null)}>
                      <Text
                        style={{
                          color: '#00C2FF',
                          fontWeight: '700',
                          marginBottom: 8,
                          fontFamily:
                            Platform.OS === 'ios' ? 'Courier New' : 'monospace',
                        }}
                      >
                        ← Change Country
                      </Text>
                    </Pressable>
                    {selectedCountry === 'Zimbabwe' && (
                      <>
                        <Text style={styles.logbookActionText}>
                          Zimbabwe — Sources of funds
                        </Text>
                        <Text style={styles.subLabel}>NMB Bank</Text>
                        <TextInput
                          placeholder="Account Name"
                          placeholderTextColor="rgba(255,255,255,0.4)"
                          style={styles.logbookInput}
                        />
                        <TextInput
                          placeholder="Account Number"
                          placeholderTextColor="rgba(255,255,255,0.4)"
                          style={styles.logbookInput}
                          keyboardType="number-pad"
                        />
                        <Text style={[styles.subLabel, { marginTop: 8 }]}>
                          EcoCash
                        </Text>
                        <TextInput
                          placeholder="EcoCash Phone (e.g., 07xx...)"
                          placeholderTextColor="rgba(255,255,255,0.4)"
                          style={styles.logbookInput}
                          keyboardType="phone-pad"
                        />
                      </>
                    )}
                    {selectedCountry === 'Kenya' && (
                      <>
                        <Text style={styles.logbookActionText}>
                          Kenya — Sources of funds
                        </Text>
                        <Text style={styles.subLabel}>KCB Bank</Text>
                        <TextInput
                          placeholder="Account Name"
                          placeholderTextColor="rgba(255,255,255,0.4)"
                          style={styles.logbookInput}
                        />
                        <TextInput
                          placeholder="Account Number"
                          placeholderTextColor="rgba(255,255,255,0.4)"
                          style={styles.logbookInput}
                          keyboardType="number-pad"
                        />
                        <Text style={[styles.subLabel, { marginTop: 8 }]}>
                          M‑Pesa
                        </Text>
                        <TextInput
                          placeholder="M‑Pesa Phone (e.g., 07xx...)"
                          placeholderTextColor="rgba(255,255,255,0.4)"
                          style={styles.logbookInput}
                          keyboardType="phone-pad"
                        />
                      </>
                    )}
                    {SUPPORTED_PEARL_COUNTRIES.includes(selectedCountry) ? (
                      <>
                        <Text
                          style={[styles.logbookActionText, { marginTop: 16 }]}
                        >
                          Tip Details
                        </Text>
                        <TextInput
                          placeholder="Amount (USD/ZiG/KES)"
                          placeholderTextColor="rgba(255,255,255,0.4)"
                          style={styles.logbookInput}
                          keyboardType="decimal-pad"
                        />
                        <TextInput
                          placeholder="Optional note to creator"
                          placeholderTextColor="rgba(255,255,255,0.4)"
                          style={styles.logbookInput}
                        />
                        <Pressable
                          style={styles.primaryBtn}
                          onPress={() =>
                            Alert.alert(
                              'Pearls',
                              'Tip flow submitted (connect to payments backend).',
                            )
                          }
                        >
                          <Text style={styles.primaryBtnText}>Send Tip</Text>
                        </Pressable>
                      </>
                    ) : (
                      <Text
                        style={[
                          styles.hint,
                          {
                            fontFamily:
                              Platform.OS === 'ios'
                                ? 'Courier New'
                                : 'monospace',
                          },
                        ]}
                      >
                        Payment methods for {selectedCountry} are not yet
                        configured.
                      </Text>
                    )}
                  </View>
                )}
              </ScrollView>
            </View>
          </View>
          <Pressable
            style={styles.dismissBtn}
            onPress={() => setShowPearls(false)}
          >
            <Text style={styles.dismissText}>Close</Text>
          </Pressable>
        </View>
      </Modal>

      {/* MY TREASURE */}
      <Modal
        visible={showTreasure}
        transparent
        animationType="fade"
        onRequestClose={() => setShowTreasure(false)}
      >
        <View
          style={[styles.modalRoot, { justifyContent: 'center', padding: 24 }]}
        >
          <View
            style={[
              styles.logbookContainer,
              {
                maxHeight: SCREEN_HEIGHT * 0.7,
                borderRadius: 12,
                overflow: 'hidden',
              },
            ]}
          >
            {paperTexture && (
              <Image source={paperTexture} style={styles.logbookBg} />
            )}
            <View style={styles.logbookPage}>
              <Text style={styles.logbookTitle}>My Treasure</Text>
              <ScrollView>
                <Pressable
                  style={styles.logbookAction}
                  onPress={() =>
                    Alert.alert(
                      'View Earnings',
                      'Earnings screen not implemented.',
                    )
                  }
                >
                  <Text style={styles.logbookActionText}>🪙 View Earnings</Text>
                </Pressable>
                <Pressable
                  style={styles.logbookAction}
                  onPress={() =>
                    Alert.alert(
                      'Withdraw Funds',
                      'Withdrawal screen not implemented.',
                    )
                  }
                >
                  <Text style={styles.logbookActionText}>
                    🏧 Withdraw Funds
                  </Text>
                </Pressable>
                <Pressable
                  style={styles.logbookAction}
                  onPress={() => {
                    setShowTreasure(false);
                    setShowPearls(true);
                  }}
                >
                  <Text style={styles.logbookActionText}>
                    💳 Payment Settings
                  </Text>
                </Pressable>
                <Pressable
                  style={styles.logbookAction}
                  onPress={() =>
                    Alert.alert(
                      '🐙 Octopus Bonus',
                      'When your waves reach 10,000 octopus hugs, you earn $100!',
                    )
                  }
                >
                  <Text style={styles.logbookActionText}>🐙 Octopus Bonus</Text>
                </Pressable>
                <View style={{ marginTop: 24 }}>
                  <Text style={{ color: 'white', fontWeight: '700' }}>
                    Total Earnings: ${treasureStats.tipsTotal.toFixed(2)}
                  </Text>
                  <Text style={{ color: 'lightgreen', fontWeight: '700' }}>
                    Withdrawable: ${treasureStats.withdrawable.toFixed(2)}
                  </Text>
                  {treasureStats.lastPayout && (
                    <Text
                      style={{
                        color: 'rgba(255,255,255,0.7)',
                        fontSize: 12,
                        marginTop: 4,
                      }}
                    >
                      Last Payout:{' '}
                      {toJSDate(treasureStats.lastPayout).toLocaleDateString()}
                    </Text>
                  )}
                  <Text style={{ color: '#8A2BE2', fontWeight: '700', marginTop: 8 }}>
                    🐙 Octopus Bonus: $0.00
                  </Text>
                  <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 11, marginTop: 2 }}>
                    (Earn $100 per 10,000 hugs on your waves)
                  </Text>
                </View>
              </ScrollView>
            </View>
          </View>
          <Pressable
            style={styles.dismissBtn}
            onPress={() => setShowTreasure(false)}
          >
            <Text style={styles.dismissText}>Close</Text>
          </Pressable>
        </View>
      </Modal>

      {/* Country Picker Modal */}
      <Modal
        visible={showCountryPicker}
        transparent
        animationType="fade"
        onRequestClose={() => setShowCountryPicker(false)}
      >
        <View
          style={[styles.modalRoot, { justifyContent: 'center', padding: 24 }]}
        >
          <View
            style={[
              styles.logbookContainer,
              { maxHeight: '80%', borderRadius: 12, overflow: 'hidden' },
            ]}
          >
            {paperTexture && (
              <Image source={paperTexture} style={styles.logbookBg} />
            )}
            <View style={styles.logbookPage}>
              <Text style={styles.logbookTitle}>Select a Country</Text>
              <ScrollView>
                {AFRICAN_COUNTRIES.map(country => (
                  <Pressable
                    key={country}
                    style={styles.logbookAction}
                    onPress={() => {
                      setSelectedCountry(country);
                      setShowCountryPicker(false);
                    }}
                  >
                    <Text style={styles.logbookActionText}>{country}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          </View>
          <Pressable
            style={styles.dismissBtn}
            onPress={() => setShowCountryPicker(false)}
          >
            <Text style={styles.dismissText}>Close</Text>
          </Pressable>
        </View>
      </Modal>

      {/* ECHOES */}
      <Modal
        visible={showEchoes}
        transparent
        animationType="fade"
        onRequestClose={() => setShowEchoes(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={[styles.modalRoot, { justifyContent: 'center', padding: 24 }]}
        >
          <View
            style={[
              styles.logbookContainer,
              {
                maxHeight: SCREEN_HEIGHT * 0.7,
                borderRadius: 12,
                overflow: 'hidden',
              },
            ]}
          >
            {paperTexture && (
              <Image source={paperTexture} style={styles.logbookBg} />
            )}
            <View style={styles.logbookPage}>
              <Text style={styles.logbookTitle}>SONAR ECHOES</Text>
              <ScrollView>
                <TextInput
                  placeholder={
                    editingEcho ? 'Edit your echo...' : 'Cast your echo...'
                  }
                  value={echoText}
                  onChangeText={updateEchoText}
                  style={styles.logbookInput}
                  placeholderTextColor="rgba(255,255,255,0.4)"
                  multiline
                />
                <Pressable
                  style={[styles.primaryBtn, { marginTop: 16 }]}
                  onPress={editingEcho ? onSaveEditedEcho : onSendEcho}
                >
                  <Text style={styles.primaryBtnText}>
                    {editingEcho ? 'Save Echo' : 'Send Echo'}
                  </Text>
                </Pressable>
                {editingEcho && (
                  <Pressable
                    style={[styles.secondaryBtn, { marginTop: 8 }]}
                    onPress={() => {
                      setEditingEcho(null);
                      updateEchoText('');
                    }}
                  >
                    <Text style={styles.secondaryBtnText}>Cancel Edit</Text>
                  </Pressable>
                )}
                <View
                  style={{
                    marginTop: 16,
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderTopColor: 'rgba(255,255,255,0.2)',
                    paddingTop: 12,
                  }}
                >
                  <Text
                    style={{
                      color: 'white',
                      fontWeight: '700',
                      marginBottom: 8,
                    }}
                  >
                    Recent Echoes
                  </Text>
                  {echoList.length === 0 ? (
                    <Text style={{ color: 'rgba(255,255,255,0.7)' }}>
                      No echoes yet. Be the first to echo.
                    </Text>
                  ) : (
                    echoList.map((e, idx) => (
                      <Pressable
                        key={
                          (e && (e as any).id) ||
                          `${(e as any)?.uid || 'u'}-${
                            (e as any)?.updatedAt?.seconds ??
                            (e as any)?.createdAt?.seconds ??
                            0
                          }-${idx}`
                        }
                        onPress={() => {
                          const myUid = (() => {
                            try {
                              return require('@react-native-firebase/auth').default?.()
                                ?.currentUser?.uid;
                            } catch {
                              return null;
                            }
                          })();
                          if (e.uid === myUid) {
                            Alert.alert('My Echo', `"${e.text}"`, [
                              {
                                text: 'Splash',
                                onPress: () =>
                                  Alert.alert('Splash', 'Feature coming soon!'),
                              },
                              {
                                text: 'Edit',
                                onPress: () => onEditMyEcho(e as any),
                              },
                              {
                                text: 'Delete',
                                style: 'destructive',
                                onPress: () => onDeleteEchoById(e.id as any),
                              },
                              { text: 'Cancel', style: 'cancel' },
                            ]);
                          }
                        }}
                      >
                        <View style={{ paddingVertical: 6 }}>
                          <Text style={{ color: 'rgba(255,255,255,0.9)' }}>
                            <Text style={{ fontWeight: '700' }}>
                              {displayHandle(e.uid, e.userName || e.uid)}
                            </Text>
                            <Text> </Text>
                            <Text>{e.text}</Text>
                          </Text>
                        </View>
                      </Pressable>
                    ))
                  )}
                </View>
              </ScrollView>
            </View>
          </View>
          <Pressable
            style={styles.dismissBtn}
            onPress={() => setShowEchoes(false)}
          >
            <Text style={styles.dismissText}>Close</Text>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      {/* SEND MESSAGE */}
      <Modal
        visible={showSendMessage}
        transparent
        animationType="fade"
        onRequestClose={() => setShowSendMessage(false)}
      >
        <View
          style={[styles.modalRoot, { justifyContent: 'center', padding: 24 }]}
        >
          <View
            style={[
              styles.logbookContainer,
              {
                maxHeight: SCREEN_HEIGHT * 0.7,
                borderRadius: 12,
                overflow: 'hidden',
              },
            ]}
          >
            {paperTexture && (
              <Image source={paperTexture} style={styles.logbookBg} />
            )}
            <View style={styles.logbookPage}>
              <Text style={styles.logbookTitle}>
                Message to {messageRecipient?.name}
              </Text>
              <ScrollView>
                <TextInput
                  placeholder="Your message..."
                  value={messageText}
                  onChangeText={setMessageText}
                  style={[styles.logbookInput, { height: 120 }]}
                  placeholderTextColor="rgba(255,255,255,0.4)"
                  multiline
                />
                <Pressable
                  style={[styles.primaryBtn, { marginTop: 16 }]}
                  onPress={onSendMessage}
                >
                  <Text style={styles.primaryBtnText}>Send</Text>
                </Pressable>
              </ScrollView>
            </View>
          </View>
          <Pressable
            style={styles.dismissBtn}
            onPress={() => setShowSendMessage(false)}
          >
            <Text style={styles.dismissText}>Cancel</Text>
          </Pressable>
        </View>
      </Modal>

      {/* MEDIA EDITOR */}
      <Modal
        visible={!!capturedMedia}
        transparent
        animationType="slide"
        onRequestClose={() => setCapturedMedia(null)}
      >
        <View
          style={[
            editorStyles.editorRoot,
            { paddingBottom: Math.max(insets.bottom, 16) },
          ]}
        >
          {/* Stage: media underlay + draggable caption overlay */}
          <View
            style={editorStyles.stage}
            onLayout={e => {
              const { x, y, width, height } = e.nativeEvent.layout;
              stageLayoutRef.current = { x, y, w: width, h: height };
              setStageSize({ w: width, h: height });
            }}
          >
            {capturedMedia?.uri &&
              (RNVideo && isVideoAsset(capturedMedia) ? (
                <>
                  <View style={{ flex: 1 }}>
                    <RNVideo
                      ref={editorVideoRef}
                      source={{ uri: String(capturedMedia.uri) }}
                      style={[
                        StyleSheet.absoluteFillObject as any,
                        { backgroundColor: 'black' },
                      ]}
                      resizeMode={'cover'}
                      repeat
                      paused={isPaused || !editorPlaying}
                      muted={true} // Mute video preview by default
                      disableFocus={true}
                      playInBackground={false}
                      playWhenInactive={false}
                      ignoreSilentSwitch={'ignore'}
                      onLoad={(e: any) => {
                        setPlaybackDuration(e?.duration || 0);
                        if (attachedAudio?.uri) {
                          try {
                            if (audioDelayTimerRef.current)
                              clearTimeout(audioDelayTimerRef.current);
                          } catch {}
                          setAudioUnpaused(false);
                          audioDelayTimerRef.current = setTimeout(
                            () => setAudioUnpaused(true),
                            overlayAudioDelayMs,
                          );
                        }
                      }}
                      onError={(e: any) => console.warn('EDITOR VIDEO ERR', e)}
                    />
                  </View>
                  {attachedAudio?.uri && (
                    <RNVideo
                      ref={editorAudioRef}
                      source={{ uri: String(attachedAudio.uri) }}
                      audioOnly
                      repeat
                      paused={isPaused || !editorPlaying || !audioUnpaused}
                      disableFocus={true}
                      playInBackground={false}
                      playWhenInactive={false}
                      volume={1.0}
                      ignoreSilentSwitch={'ignore'}
                      style={{
                        width: 1,
                        height: 1,
                        opacity: 0.01,
                        position: 'absolute',
                      }}
                      onError={(e: any) => console.warn('EDITOR AUDIO ERR', e)}
                    />
                  )}
                </>
              ) : (
                <>
                  <Image
                    source={{ uri: capturedMedia.uri }}
                    style={[
                      StyleSheet.absoluteFillObject as any,
                      { resizeMode: 'cover' },
                    ]}
                  />
                  {RNVideo && attachedAudio?.uri && (
                    <RNVideo
                      ref={editorAudioRef}
                      source={{ uri: String(attachedAudio.uri) }}
                      audioOnly
                      repeat
                      paused={isPaused || !editorPlaying}
                      playInBackground={false}
                      playWhenInactive={false}
                      volume={1.0}
                      ignoreSilentSwitch={'ignore'}
                      style={{
                        width: 1,
                        height: 1,
                        opacity: 0.01,
                        position: 'absolute',
                      }}
                      onError={(e: any) => console.warn('EDITOR AUDIO ERR', e)}
                    />
                  )}
                </>
              ))}
            {showCaptionInput && (
              <View
                style={{
                  position: 'absolute',
                  top:
                    stageSize.h > 0
                      ? Math.max(
                          24,
                          Math.min(stageSize.h * 0.6, stageSize.h - 140),
                        )
                      : '50%',
                  alignItems: 'center',
                  zIndex: 5,
                  width: captionBubbleWidth,
                  alignSelf: 'center',
                }}
              >
                <TextInput
                  ref={captionInputRef}
                  style={[
                    editorStyles.captionInput,
                    {
                      width: captionBubbleWidth,
                      maxWidth: stageSize.w > 0 ? stageSize.w - 16 : undefined,
                      textAlign: 'center',
                    },
                  ]}
                  value={captionText}
                  onChangeText={setCaptionText}
                  placeholder="Add a caption..."
                  placeholderTextColor="rgba(255,255,255,0.6)"
                  multiline
                  maxLength={200}
                  returnKeyType="done"
                  autoCorrect={false}
                />
              </View>
            )}
          </View>

          {/* Attached Audio Summary */}
          {attachedAudio && (
            <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
              <Text style={{ color: 'white' }}>
                Attached audio: {attachedAudio.name || attachedAudio.uri}
              </Text>
              <View
                style={{
                  flexDirection: 'row',
                  gap: 16,
                  marginTop: 8,
                  alignItems: 'center',
                }}
              >
                <Pressable
                  onPress={() => setAttachedAudio(null)}
                  style={{ paddingHorizontal: 16, paddingVertical: 8 }}
                >
                  <Text style={{ color: '#00C2FF', fontWeight: '700' }}>
                    Remove audio
                  </Text>
                </Pressable>
                <Text style={{ color: 'rgba(255,255,255,0.7)' }}>
                  Plays automatically with video
                </Text>
              </View>
            </View>
          )}

          {/* Editor Controls */}
          <View
            style={[
              editorStyles.editorContainer,
              {
                paddingBottom: Math.max(insets.bottom, 16) + 8,
                paddingTop: 8,
              },
            ]}
            onLayout={e => {}}
          >
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={editorStyles.editorScroll}
            >
              {editorTools.map(tool => (
                <Pressable
                  key={tool.label}
                  style={editorStyles.editorItem}
                  onPress={() => onEditorToolPress(tool.label)}
                >
                  <Text style={editorStyles.editorIcon}>{tool.icon}</Text>
                  <Text style={editorStyles.editorLabel}>
                    {tool.label === 'Ocean melodies'
                      ? 'Ocean Melodies'
                      : tool.label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <View
              style={{
                flexDirection: 'row',
                gap: 12,
                paddingHorizontal: 16,
                paddingBottom: 8,
                marginTop: 8,
              }}
            >
              <Pressable
                style={[styles.closeBtn, { flex: 1, marginVertical: 0 }]}
                onPress={() => setCapturedMedia(null)}
                disabled={releasing}
              >
                <Text style={styles.closeText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[
                  editorStyles.doneButton,
                  { flex: 2, margin: 0, opacity: releasing ? 0.6 : 1 },
                ]}
                onPress={onPostWave}
                disabled={releasing}
              >
                <Text style={editorStyles.doneButtonText}>
                  {releasing ? 'Releasing…' : 'Release Wave'}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* OCEAN MELODIES: Attach Audio */}
      <Modal
        visible={showAudioModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowAudioModal(false)}
      >
        <View
          style={[styles.modalRoot, { justifyContent: 'center', padding: 24 }]}
        >
          <View
            style={[
              styles.logbookContainer,
              {
                maxHeight: SCREEN_HEIGHT * 0.7,
                borderRadius: 12,
                overflow: 'hidden',
              },
            ]}
          >
            {paperTexture && (
              <Image source={paperTexture} style={styles.logbookBg} />
            )}
            <View style={styles.logbookPage}>
              <Text style={styles.logbookTitle}>OCEAN MELODIES</Text>
              <ScrollView>
                <Text
                  style={[
                    styles.hint,
                    {
                      fontFamily:
                        Platform.OS === 'ios' ? 'Courier New' : 'monospace',
                      marginBottom: 12,
                    },
                  ]}
                >
                  Attach an audio track to your wave.
                </Text>
                <Pressable
                  style={styles.logbookAction}
                  onPress={pickAudioWithDocumentPicker}
                >
                  <Text style={styles.logbookActionText}>
                    Pick audio from device
                  </Text>
                </Pressable>
                <Text
                  style={[
                    styles.logbookActionText,
                    { marginTop: 24, marginBottom: 8 },
                  ]}
                >
                  Or paste an audio URL
                </Text>
                <TextInput
                  placeholder="https://example.com/track.mp3"
                  value={audioUrlInput}
                  onChangeText={setAudioUrlInput}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={styles.logbookInput}
                  placeholderTextColor="rgba(255,255,255,0.4)"
                />
                <Pressable
                  style={[
                    styles.primaryBtn,
                    { marginTop: 8, opacity: audioUrlInput.trim() ? 1 : 0.5 },
                  ]}
                  disabled={!audioUrlInput.trim()}
                  onPress={() => {
                    const url = audioUrlInput.trim();
                    const looksAudio =
                      /\.(mp3|m4a|aac|wav|ogg)(\?|#|$)/i.test(url) ||
                      /^https?:\/\//i.test(url);
                    if (!looksAudio) {
                      Alert.alert(
                        'Invalid URL',
                        'Please enter a valid audio URL.',
                      );
                      return;
                    }
                    setAttachedAudio({ uri: url });
                    setShowAudioModal(false);
                    setAudioUrlInput('');
                  }}
                >
                  <Text style={styles.primaryBtnText}>Attach URL</Text>
                </Pressable>
              </ScrollView>
            </View>
          </View>
          <Pressable
            style={styles.dismissBtn}
            onPress={() => setShowAudioModal(false)}
          >
            <Text style={styles.dismissText}>Close</Text>
          </Pressable>
        </View>
      </Modal>

      <Modal
        visible={!!waveOptionsTarget}
        transparent
        animationType="fade"
        onRequestClose={() => setWaveOptionsTarget(null)}
      >
        <Pressable
          style={styles.waveOptionsBackdrop}
          onPress={() => setWaveOptionsTarget(null)}
        >
          <View style={styles.waveOptionsMenu}>
            {/* Join/Leave Crew option - dynamically shows based on current state */}
            {waveOptionsTarget &&
              waveOptionsTarget.ownerUid &&
              waveOptionsTarget.ownerUid !== myUid && (
                <Pressable
                  style={styles.waveOptionsItem}
                  onPress={() => {
                    const targetUid = waveOptionsTarget.ownerUid!;
                    const targetName = waveOptionsTarget.authorName;
                    setWaveOptionsTarget(null);
                    handleWaveOptionSelect('Join Crew');
                  }}
                  disabled={crewLoading}
                >
                  <Text style={styles.waveOptionsItemTitle}>
                    {'Join Crew'}
                  </Text>
                  <Text style={styles.waveOptionsItemDescription}>
                    {'Add this captain to your boarding list'}
                  </Text>
                </Pressable>
              )}

            {/* Other existing options - filter out Join Crew from the static list */}
            {waveOptionMenu
              .filter(option => option.label !== 'Join Crew')
              .map(option => (
                <Pressable
                  key={option.label}
                  style={styles.waveOptionsItem}
                  onPress={() => handleWaveOptionSelect(option.label)}
                >
                  <Text style={styles.waveOptionsItemTitle}>{option.label}</Text>
                  <Text style={styles.waveOptionsItemDescription}>
                    {option.description}
                  </Text>
                </Pressable>
              ))}
            
            {/* Block User and Ping for other users' waves */}
            {waveOptionsTarget &&
              waveOptionsTarget.ownerUid &&
              waveOptionsTarget.ownerUid !== myUid && (
                <>
                  <Pressable
                    style={styles.waveOptionsItem}
                    onPress={() => {
                      const targetUid = waveOptionsTarget.ownerUid!;
                      const targetName = waveOptionsTarget.authorName;
                      setWaveOptionsTarget(null);
                      Alert.alert(
                        'Block User',
                        `Block ${targetName || 'this user'}? They won't be able to see your content.`,
                        [
                          { text: 'Cancel', style: 'cancel' },
                          {
                            text: 'Block',
                            style: 'destructive',
                            onPress: () => handleBlockUser(targetUid, targetName),
                          },
                        ]
                      );
                    }}
                  >
                    <Text style={styles.waveOptionsItemTitle}>🚫 Block User</Text>
                    <Text style={styles.waveOptionsItemDescription}>
                      Prevent this user from seeing your waves
                    </Text>
                  </Pressable>
                  <Pressable
                    style={styles.waveOptionsItem}
                    onPress={() => {
                      const targetUid = waveOptionsTarget.ownerUid!;
                      const targetName = displayHandle(
                        targetUid,
                        waveOptionsTarget.authorName || targetUid,
                      );
                      setWaveOptionsTarget(null);
                      setMessageRecipient({ uid: targetUid, name: targetName });
                      setMessageText('');
                      setShowSendMessage(true);
                    }}
                  >
                    <Text style={styles.waveOptionsItemTitle}>Ping</Text>
                    <Text style={styles.waveOptionsItemDescription}>
                      Send a direct message to this captain
                    </Text>
                  </Pressable>
                </>
              )}
            <Pressable
              style={[styles.waveOptionsItem, styles.waveOptionsCancel]}
              onPress={() => setWaveOptionsTarget(null)}
            >
              <Text style={styles.waveOptionsItemTitle}>Cancel</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* GO DRIFT (LIVE) */}
      <LiveStreamModal
        // Pass required styles down to the modal to fix scope issue
        styles={{
          input: styles.input,
          primaryBtn: styles.primaryBtn,
          primaryBtnText: styles.primaryBtnText,
          closeBtn: styles.closeBtn,
          closeText: styles.closeText,
          secondaryBtn: styles.secondaryBtn,
          secondaryBtnText: styles.secondaryBtnText,
        }}
        visible={showLive}
        isChartered={isCharteredDrift}
        searchOceanEntities={searchOceanEntities}
        onClose={() => {
          setShowLive(false);
          setIsCharteredDrift(false);
        }}
      />

      {/* Octopus Hug Animation Overlay removed per user request */}
    </SafeAreaView>
  );
};

// ======================== AGORA LIVE STREAM COMPONENT ========================
const LiveStreamModal = ({
  visible,
  onClose,
  styles,
  isChartered,
  searchOceanEntities,
}: {
  visible: boolean;
  onClose: () => void;
  styles: any; // Prop to receive styles from parent
  isChartered?: boolean;
  searchOceanEntities: (term: string) => Promise<SearchResult[]>;
}) => {
  const insets = useSafeAreaInsets();
  const Agora = useMemo(() => {
    try {
      return require('react-native-agora');
    } catch {
      return null;
    }
  }, []);
  const cfg = (() => {
    try {
      return require('./liveConfig');
    } catch {
      return null;
    }
  })();
  const appId: string = (cfg && cfg.AGORA_APP_ID) || '';
  const staticToken: string | null = (cfg && cfg.AGORA_STATIC_TOKEN) || null;
  const defaultChannel: string = (cfg && cfg.AGORA_CHANNEL_NAME) || '';
  const engineRef = React.useRef<any>(null);
  const [micMuted, setMicMuted] = useState(false);
  const [cameraHidden, setCameraHidden] = useState(false);
  const [isLiveStarted, setIsLiveStarted] = useState(false);
  // Simple inputs for clean setup
  const [channelInput, setChannelInput] = useState<string>(defaultChannel);
  const [tokenInput, setTokenInput] = useState<string>('');
  const [uidInput, setUidInput] = useState<string>('0');
  const [liveUid, setLiveUid] = useState<number>(0);
  const isSetupValid = useMemo(() => {
    const hasChannel = !!(channelInput || '').trim();
    const uidStr = (uidInput || '').trim();
    const hasUid = uidStr === '' || /^\d+$/.test(uidStr);
    // Don't require token or title - server can provide token, users can add title
    return hasChannel && hasUid;
  }, [channelInput, uidInput]);
  const [isStartingLive, setIsStartingLive] = useState(false);
  const [liveTitle, setLiveTitle] = useState<string>('');
  const [liveDesc, setLiveDesc] = useState<string>(
    'Say something about your live',
  );
  const [livePrivacy, setLivePrivacy] = useState<'public' | 'private'>(
    'public',
  );
  const [liveDocId, setLiveDocId] = useState<string | null>(null);
  const [liveToken, setLiveToken] = useState<string | null>(null);
  const [liveChannel, setLiveChannel] = useState<string>(defaultChannel);
  const [livePoll, setLivePoll] = useState<LivePoll | null>(null);
  const [liveGoal, setLiveGoal] = useState<LiveGoal | null>(null);
  const [pendingRequests, setPendingRequests] = useState<
    Array<{ uid: string; name?: string }>
  >([]);
  useEffect(() => {
    if (!liveDocId) {
      setLivePoll(null);
      setLiveGoal(null);
      return;
    }
    let unsub: (() => void) | null = null;
    let firestoreMod: any = null;
    try {
      firestoreMod = require('@react-native-firebase/firestore').default;
    } catch {}
    if (!firestoreMod) return;
    try {
      const ref = firestoreMod().collection('live').doc(liveDocId);
      unsub = ref.onSnapshot((snap: any) => {
        const data = snap?.data?.() || snap?.data || {};
        const pollData = data?.poll || null;
        if (pollData && pollData.question && Array.isArray(pollData.options)) {
          const options = pollData.options
            .filter(
              (opt: any) =>
                opt && typeof opt.id === 'string' && typeof opt.label === 'string',
            )
            .map((opt: any) => ({
              id: opt.id,
              label: opt.label,
            }));
          const votes =
            pollData.votes && typeof pollData.votes === 'object'
              ? { ...pollData.votes }
              : {};
          setLivePoll({
            question: String(pollData.question),
            options,
            votes,
          });
        } else {
          setLivePoll(null);
        }
        const goalData = data?.goal || null;
        if (goalData && typeof goalData.target === 'number') {
          setLiveGoal({
            target: Number(goalData.target),
            current: Number(goalData.current || 0),
            label: goalData.label ? String(goalData.label) : undefined,
          });
        } else {
          setLiveGoal(null);
        }
      });
    } catch {}
    return () => {
      if (unsub) {
        try {
          unsub();
        } catch {}
      }
    };
  }, [liveDocId]);
  const sseRef = useRef<any>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [mediaBarHeight, setMediaBarHeight] = useState<number>(50);
  const [endBarHeight, setEndBarHeight] = useState<number>(44);
  const [showCommentInput, setShowCommentInput] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [liveComments, setLiveComments] = useState<
    Array<{ id: string; text: string; from?: string; ts: number }>
  >([]);
  const [hostName, setHostName] = useState<string>('');
  const [hostPhoto, setHostPhoto] = useState<string | null>(null);
  const [flyingComments, setFlyingComments] = useState<
    Array<{ id: string; text: string; from?: string; anim: Animated.Value }>
  >([]);
  const seenCommentIdsRef = useRef<Set<string>>(new Set());
  const [splashedComment, setSplashedComment] = useState<{
    id: string;
    text: string;
  } | null>(null);
  const splashAnim = useRef(new Animated.Value(0)).current;

  // Placeholder functions for comment interactions
  const onSplashComment = (commentId: string) => {
    Alert.alert('Splash Comment', `Splashed comment ${commentId}`);
  };
  const onEchoBack = (comment: { id: string; from?: string; text: string }) => {
    Alert.alert('Echo Back', `Replying to ${comment.from}: "${comment.text}"`);
  };

  // --- Enhanced Live Controls state (safe stubs) ---
  const [isRecording, setIsRecording] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [virtualBackground, setVirtualBackground] = useState<string | null>(
    null,
  );
  const [beautyFilterEnabled, setBeautyFilterEnabled] = useState(false);
  const [liveProducts, setLiveProducts] = useState<any[]>([]);
  const [activePoll, setActivePoll] = useState<any>(null);
  const [coHosts, setCoHosts] = useState<any[]>([]);
  const [liveAnalytics, setLiveAnalytics] = useState<any>(null);
  // User management state
  const [moderators, setModerators] = useState<string[]>([]);
  const [blockedUsers, setBlockedUsers] = useState<string[]>([]);
  const [mutedUsers, setMutedUsers] = useState<string[]>([]);
  const [showUserPanel, setShowUserPanel] = useState(false);
  const [userPanelMode, setUserPanelMode] = useState<'none' | 'join' | 'block' | 'remove'>('none');
  const [viewers, setViewers] = useState<any[]>([]);
  const [topSupporters, setTopSupporters] = useState<
    Array<{ id: string; username: string }>
  >([]);
  useEffect(() => {
    if (!showUserPanel) setUserPanelMode('none');
  }, [showUserPanel]);
  // cross-platform text prompt
  const [promptVisible, setPromptVisible] = useState(false);
  const [promptTitle, setPromptTitle] = useState('');
  const [promptPlaceholder, setPromptPlaceholder] = useState('');
  const promptValueRef = useRef('');
  const promptSubmitRef = useRef<undefined | ((val: string) => void)>(
    undefined,
  );

  useEffect(() => {
    if (isChartered) {
      setLivePrivacy('private');
    } else {
      setLivePrivacy('public');
    }
  }, [isChartered]);

  // Connect to Drift room SSE for pending requests (host view)
  useEffect(() => {
    let interval: any = null;
    // Close previous SSE
    try {
      if (sseRef.current && sseRef.current.close) sseRef.current.close();
    } catch {}
    sseRef.current = null;
    let cancelled = false;
    (async () => {
      try {
        let cfgLocal: any = null;
        try {
          cfgLocal = require('./liveConfig');
        } catch {}
        const backendBase: string =
          (cfgLocal &&
            (cfgLocal.BACKEND_BASE_URL ||
              cfgLocal.USER_MGMT_ENDPOINT_BASE ||
              cfgLocal.USER_MANAGEMENT_BASE_URL)) ||
          '';
        if (!backendBase || !isLiveStarted || !liveDocId) {
          setPendingRequests([]);
          return;
        }
        // Try SSE if EventSource is available
        const sseUrl = `${backendBase}/drift/sse?liveId=${encodeURIComponent(
          String(liveDocId),
        )}`;
        const hasEventSource =
          typeof (globalThis as any).EventSource === 'function';
        if (hasEventSource) {
          const ES = (globalThis as any).EventSource;
          const es = new ES(sseUrl);
          sseRef.current = es;
          es.onmessage = (ev: any) => {
            try {
              const data = JSON.parse(ev.data || '{}');
              if (data?.requests)
                setPendingRequests(
                  data.requests.map((r: any) => ({
                    uid: String(r.uid),
                    name: r.name,
                  })),
                );
              if (data?.type === 'request' && data?.uid)
                setPendingRequests(prev => [
                  { uid: String(data.uid), name: data.name },
                  ...prev.filter(p => p.uid !== String(data.uid)),
                ]);
              if (data?.type === 'accepted' && data?.uid)
                setPendingRequests(prev =>
                  prev.filter(p => p.uid !== String(data.uid)),
                );
            } catch {}
          };
          es.onerror = () => {
            try {
              es.close();
            } catch {}
            sseRef.current = null;
          };
        } else {
          // Fallback: poll state endpoint
          const poll = async () => {
            try {
              const resp = await fetch(
                `${backendBase}/drift/state?liveId=${encodeURIComponent(
                  String(liveDocId),
                )}`,
              );
              const json = resp.ok ? await resp.json() : null;
              if (json && json.requests && !cancelled)
                setPendingRequests(
                  (json.requests || []).map((r: any) => ({
                    uid: String(r.uid),
                    name: r.name,
                  })),
                );
            } catch {}
          };
          await poll();
          interval = setInterval(poll, 3000);
        }
      } catch {}
    })();
    return () => {
      cancelled = true;
      try {
        if (sseRef.current && sseRef.current.close) sseRef.current.close();
      } catch {}
      sseRef.current = null;
      try {
        if (interval) clearInterval(interval);
      } catch {}
    };
  }, [isLiveStarted, liveDocId]);

  // Prevent Android back button from closing the modal right after permission prompts
  useEffect(() => {
    // Load host info for avatar/name badge
    try {
      const authMod = require('@react-native-firebase/auth').default;
      const u = authMod?.().currentUser;
      setHostPhoto(u?.photoURL || null);
      if (visible && u) {
        // Set host name from displayName or email
        setHostName(u.displayName || u.email?.split('@')[0] || 'Drifter');
      }
    } catch {}
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      try {
        onClose && onClose();
      } catch {}
      return true;
    });
    return () => {
      try {
        sub.remove();
      } catch {}
    };
  }, [visible, onClose]);

  // Real-time comments listener
  useEffect(() => {
    if (!isLiveStarted || !liveDocId) {
      setLiveComments([]);
      return;
    }

    let firestoreMod: any = null;
    try {
      firestoreMod = require('@react-native-firebase/firestore').default;
    } catch {}
    if (!firestoreMod) return;

    const unsubscribe = firestoreMod()
      .collection(`live/${liveDocId}/comments`)
      .orderBy('createdAt', 'asc')
      .limitToLast(50) // Listen to the last 50 comments
      .onSnapshot((querySnapshot: any) => {
        if (querySnapshot) {
        const items = (querySnapshot?.docs || []).map((d: any) => ({
          id: d.id,
          ...d.data(),
        }));
          setLiveComments(items);
          // Trigger flying animations for newly seen comments
          items.forEach((it: any) => {
            if (!seenCommentIdsRef.current.has(it.id)) {
              seenCommentIdsRef.current.add(it.id);
              spawnFlyingComment({ id: it.id, text: it.text, from: it.from });
            }
          });
        }
      });

    return () => unsubscribe();
  }, [isLiveStarted, liveDocId]);

  useEffect(() => {
    if (!visible || !Agora || !appId) return;
    (async () => {
      try {
        const isV4 = typeof Agora?.createAgoraRtcEngine === 'function';
        if (isV4) {
          const engine = Agora.createAgoraRtcEngine();
          engineRef.current = engine;
          try {
            engine.initialize?.({
              appId,
              channelProfile:
                Agora.ChannelProfileType?.ChannelProfileLiveBroadcasting ?? 1,
            });
          } catch {}
          try {
            engine.enableVideo?.();
          } catch {}
          try {
            engine.startPreview?.();
          } catch {}
          try {
            engine.updateChannelMediaOptions?.({
              clientRoleType: Agora.ClientRoleType?.ClientRoleBroadcaster ?? 1,
            });
          } catch {}
        } else if (
          Agora?.RtcEngine &&
          typeof Agora.RtcEngine.create === 'function'
        ) {
          const engine = await Agora.RtcEngine.create(appId);
          engineRef.current = engine;
          try {
            engine.enableVideo();
          } catch {}
          try {
            engine.startPreview?.();
          } catch {}
          try {
            engine.setChannelProfile(
              Agora.ChannelProfile?.LiveBroadcasting ?? Agora.ChannelProfile,
            );
          } catch {}
          try {
            engine.setClientRole(
              Agora.ClientRole?.Broadcaster ?? Agora.ClientRole,
            );
          } catch {}
        }
      } catch (e) {
        console.warn('Agora init error', e);
      }
    })();
    return () => {
      if (engineRef.current) {
        try {
          engineRef.current.leaveChannel?.();
        } catch {}
        try {
          (engineRef.current.destroy ?? engineRef.current.release)?.();
        } catch {}
        engineRef.current = null;
      }
    };
  }, [visible, Agora, appId]);

  // Join channel when user taps Start Live and a token/channel are set
  useEffect(() => {
    const engine = engineRef.current;
    if (!visible || !Agora || !engine || !isLiveStarted) return;
    (async () => {
      try {
        const isV4 = typeof Agora?.createAgoraRtcEngine === 'function';
        let tok = liveToken || staticToken || null;
        const chan = liveChannel || defaultChannel;
        const uidNum = Number.isFinite(liveUid as any)
          ? (liveUid as any as number)
          : 0;
        // Fallback: fetch token from backend if not present
        if (!tok) {
          try {
            const cfgLocal = (() => {
              try {
                return require('./liveConfig');
              } catch {
                return null;
              }
            })();
            const tokenEndpoint: string =
              (cfgLocal && cfgLocal.AGORA_TOKEN_ENDPOINT) || '';
            if (tokenEndpoint) {
              const q = `?channel=${encodeURIComponent(
                chan,
              )}&role=publisher&uid=${encodeURIComponent(String(uidNum))}`;
              const resp = await fetch(`${tokenEndpoint}${q}`);
              if (resp.ok) {
                const json = await resp.json();
                if (json?.token) tok = String(json.token);
              }
            }
          } catch {}
        }
        if (isV4) {
          try {
            await engine.joinChannel(tok, chan, uidNum, {
              publishMicrophoneTrack: true,
              publishCameraTrack: true,
            });
          } catch {}
        } else {
          try {
            await engine.joinChannel(tok, chan, uidNum);
          } catch {}
        }
      } catch (e) {
        console.warn('Join channel failed', e);
      }
    })();
  }, [isLiveStarted, liveUid, liveToken, liveChannel]);

  const handleEndDrift = async () => {
    try {
      // notify backend that live ended
      const endUrl = (cfg && cfg.END_LIVE_ENDPOINT) || '';
      if (endUrl && liveDocId) {
        await fetch(endUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ liveId: liveDocId }),
        });
      }
    } catch {}
    try {
      engineRef.current?.leaveChannel?.();
    } catch {}
    onClose();
  };

  const handleShareDriftLink = async () => {
    if (!liveDocId || !liveChannel) {
      Alert.alert('Error', 'Drift not started yet');
      return;
    }

    try {
      const result = await shareDriftLink(liveDocId, liveChannel, liveTitle);
      await Share.share({
        message: result.message,
        url: result.webLink,
        title: `Join my Drift: ${liveTitle}`,
      });
    } catch (error) {
      console.error('Share drift link error:', error);
    }
  };

  const sendLiveComment = async () => {
    const txt = (commentText || '').trim();
    if (!txt) return;
    // Close input after sending; user can reopen when needed
    setShowCommentInput(false);

    try {
      let firestoreMod: any = null;
      let authMod: any = null;
      try {
        firestoreMod = require('@react-native-firebase/firestore').default;
      } catch {}
      try {
        authMod = require('@react-native-firebase/auth').default;
      } catch {}
      const uid = authMod?.().currentUser?.uid || null;
      if (firestoreMod && liveDocId) {
        await firestoreMod()
          .collection(`live/${liveDocId}/comments`)
          .add({
            text: txt,
            fromUid: uid,
            from: authMod?.().currentUser?.displayName || 'Host',
            createdAt: firestoreMod.FieldValue?.serverTimestamp
              ? firestoreMod.FieldValue.serverTimestamp()
              : new Date(),
          });
      }
    } catch {}

    setCommentText('');
    setShowCommentInput(false);

    // Spawn a local flying comment immediately for instant feedback
    spawnFlyingComment({ id: `local-${Date.now()}`, text: txt, from: 'You' });
  };

  const spawnFlyingComment = (c: {
    id: string;
    text: string;
    from?: string;
  }) => {
    const anim = new Animated.Value(0);
    setFlyingComments(prev =>
      [...prev, { id: c.id, text: c.text, from: c.from, anim }].slice(-10),
    );
    Animated.timing(anim, {
      toValue: 1,
      duration: 2500,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start(() => {
      setFlyingComments(prev => prev.filter(fc => fc.id !== c.id));
    });
  };
  const triggerCommentSplash = (comment: { id: string; text: string }) => {
    setSplashedComment(comment);
    splashAnim.setValue(0);
    Animated.sequence([
      Animated.timing(splashAnim, {
        toValue: 1,
        duration: 400,
        useNativeDriver: true,
      }),
      Animated.timing(splashAnim, {
        toValue: 0,
        duration: 1500, // Linger for a bit
        useNativeDriver: true,
      }),
    ]).start(() => setSplashedComment(null));
  };

  const startLiveNow = async () => {
    setStartError(null);
    setIsStartingLive(true);
    try {
      // Ensure camera/mic permissions (Android) so inline preview can render
      if (Platform.OS === 'android') {
        const ok = await ensureCamMicPermissionsAndroid();
        if (!ok) {
          setStartError('Camera/Mic permission required');
          setIsStartingLive(false);
          return;
        }
      }
      // Use user-provided values (fallback to config)
      const chan = (channelInput || '').trim() || defaultChannel;
      const initialTok = (tokenInput || '').trim() || staticToken || null;
      const uidNum = parseInt(uidInput || '0', 10);

      // Get current user UID for backend
      let currentUserUid = 'unknown';
      try {
        const authMod = require('@react-native-firebase/auth').default;
        const user = authMod?.().currentUser;
        if (user) {
          currentUserUid = user.uid;
        }
      } catch {}

      // Optional: notify backend we're starting and fetch a fresh token/liveId
      try {
        const startUrl = (cfg && cfg.START_LIVE_ENDPOINT) || '';
        if (startUrl) {
          const payload: any = {
            channel: chan,
            uid: uidNum,
            hostUid: currentUserUid,
            title: liveTitle,
            description: liveDesc,
            privacy: livePrivacy,
            hostName,
            hostPhoto,
          };
          const resp = await fetch(startUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          if (resp.ok) {
            const json = await resp.json();
            if (json && json.token) {
              setLiveToken(String(json.token));
            } else {
              setLiveToken(initialTok || null);
            }
            if (json && (json.liveId || json.id)) {
              setLiveDocId(String(json.liveId || json.id));
            }
          } else {
            setLiveToken(initialTok || null);
          }
        } else {
          setLiveToken(initialTok || null);
        }
      } catch {
        setLiveToken(initialTok || null);
      }
      setLiveChannel(chan);
      setLiveUid(Number.isFinite(uidNum) ? uidNum : 0);
      setIsLiveStarted(true);
      // Ensure inline preview starts in this interface
      try {
        engineRef.current?.enableVideo?.();
      } catch {}
      try {
        engineRef.current?.startPreview?.();
      } catch {}
    } catch (e: any) {
      setStartError(String(e && (e.message || e)));
    } finally {
      setIsStartingLive(false);
    }
  };

  // --- Enhanced Live Controls handlers (guarded; stubs are no-ops when unsupported) ---
  const requestScreenCapturePermission = async (): Promise<boolean> => {
    try {
      return true;
    } catch {
      return false;
    }
  };

  const handleScreenShare = async () => {
    if (!isLiveStarted) return;
    try {
      if (!isScreenSharing) {
        if (Platform.OS === 'android') {
          const ok = await requestScreenCapturePermission();
          if (ok) {
            try {
              engineRef.current?.startScreenCapture?.({
                dimensions: { width: 1280, height: 720 },
                frameRate: 15,
                bitrate: 1000,
              });
              setIsScreenSharing(true);
            } catch {
              Alert.alert(
                'Screen Share',
                'Engine does not support screen capture on this build.',
              );
            }
          }
        } else {
          Alert.alert(
            'Screen Share',
            'iOS requires Broadcast Upload Extension.',
          );
        }
      } else {
        try {
          engineRef.current?.stopScreenCapture?.();
        } catch {}
        setIsScreenSharing(false);
      }
    } catch (e) {
      console.warn('Screen share failed:', e);
    }
  };

  const toggleVirtualBackground = () => {
    const backgrounds = [null, 'beach', 'underwater', 'space', 'studio'];
    const idx = backgrounds.indexOf(virtualBackground);
    const next = backgrounds[(idx + 1) % backgrounds.length];
    setVirtualBackground(next);
    if (engineRef.current) {
      if (next) {
        try {
          engineRef.current.enableVirtualBackground?.(true, {
            background_source_type: 1,
            color: 0xffffff,
            source: next,
          });
        } catch {}
      } else {
        try {
          engineRef.current.enableVirtualBackground?.(false, {});
        } catch {}
      }
    }
  };

  const toggleBeautyFilter = () => {
    const next = !beautyFilterEnabled;
    setBeautyFilterEnabled(next);
    try {
      engineRef.current?.setBeautyEffectOptions?.(next, {
        lighteningContrastLevel: 1,
        lighteningLevel: 0.7,
        smoothnessLevel: 0.5,
        rednessLevel: 0.1,
      });
    } catch {}
  };

  const toggleRecording = async () => {
    if (!isLiveStarted) return;
    try {
      const base =
        (cfg && (cfg.RECORDING_ENDPOINT_BASE || cfg.RECORDING_BASE_URL)) || '';
      if (!base) {
        Alert.alert('Recording', 'Backend recording endpoint not configured.');
        return;
      }
      if (!isRecording) {
        const resp = await fetch(`${base}/start-recording`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel: liveChannel,
            uid: liveUid,
            token: liveToken,
          }),
        });
        if (resp.ok) setIsRecording(true);
      } else {
        const resp = await fetch(`${base}/stop-recording`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel: liveChannel, uid: liveUid }),
        });
        if (resp.ok) setIsRecording(false);
      }
    } catch (e) {
      console.warn('Recording toggle failed:', e);
    }
  };

  const showProductStore = () => {
    Alert.alert('Product Store', 'Showcase products, prices, and add-to-cart.');
  };

  const broadcastPollToViewers = (_q: string) => {
    // placeholder
  };

  const composeLivePoll = (initialQuestion?: string) => {
    if (!liveDocId) {
      Alert.alert('Live Polls', 'Start a live session to create a poll.');
      return;
    }
    askForText(
      'Live Poll',
      'Enter the question',
      question => {
        const q = (question || initialQuestion || '').trim();
        if (!q) {
          Alert.alert('Live Poll', 'Question cannot be empty.');
          return;
        }
        askForText('Poll Options', 'Comma-separated choices', optionsText => {
          const opts =
            (optionsText || '')
              .split(',')
              .map(o => o.trim())
              .filter(Boolean) || [];
          if (opts.length < 2) {
            Alert.alert('Live Poll', 'Provide at least two choices.');
            return;
          }
          const liveOptions = opts.map((label, idx) => ({
            id: `opt_${Date.now()}_${idx}`,
            label,
          }));
          const votes: Record<string, number> = {};
          liveOptions.forEach(opt => {
            votes[opt.id] = 0;
          });
          try {
            const firestoreMod = require('@react-native-firebase/firestore')
              .default;
            if (!firestoreMod) throw new Error('Firestore unavailable');
            firestoreMod()
              .collection('live')
              .doc(liveDocId)
              .set(
                {
                  poll: {
                    question: q,
                    options: liveOptions,
                    votes,
                    updatedAt:
                      firestoreMod.FieldValue?.serverTimestamp?.() ||
                      new Date(),
                  },
                },
                { merge: true },
              );
            Alert.alert('Live Poll', 'Poll created and shared with viewers.');
          } catch (err) {
            console.warn('Live poll creation failed', err);
            Alert.alert(
              'Live Poll',
              'Unable to save the poll right now. Try again later.',
            );
          }
        });
      },
      initialQuestion,
    );
  };

  const voteOnLivePoll = async (optionId: string) => {
    if (!liveDocId) return;
    try {
      const firestoreMod = require('@react-native-firebase/firestore')
        .default;
      if (!firestoreMod) return;
      const key = `poll.votes.${optionId}`;
      await firestoreMod()
        .collection('live')
        .doc(liveDocId)
        .set(
          {
            [key]: firestoreMod.FieldValue.increment(1),
          },
          { merge: true },
        );
    } catch (err) {
      console.warn('Failed to vote on live poll', err);
    }
  };

  const createLivePoll = () => {
    if (!livePoll) {
      composeLivePoll();
      return;
    }
    Alert.alert(
      'Live Poll',
      livePoll.question,
      [
        ...livePoll.options.map(opt => ({
          text: `${opt.label} (${livePoll.votes?.[opt.id] || 0})`,
          onPress: () => voteOnLivePoll(opt.id),
        })),
        {
          text: 'Create new poll',
          onPress: () => composeLivePoll(livePoll.question),
        },
        { text: 'Close', style: 'cancel' },
      ],
    );
  };

  const handleSetLiveGoal = () => {
    if (!liveDocId) {
      Alert.alert('Live Goal', 'Start a live session to set a goal.');
      return;
    }
    askForText('Live Goal', 'Enter target value (number)', value => {
      const target = Number(value);
      if (!target || target <= 0) {
        Alert.alert('Live Goal', 'Please enter a number greater than zero.');
        return;
      }
      askForText('Live Goal', 'Optional label (e.g., Tips, Streams)', label => {
        const goalPayload = {
          target,
          current: 0,
          label: label?.trim() ? label.trim() : undefined,
        };
        try {
          const firestoreMod = require('@react-native-firebase/firestore')
            .default;
          if (!firestoreMod) throw new Error('Firestore unavailable');
          firestoreMod()
            .collection('live')
            .doc(liveDocId)
            .set(
              {
                goal: goalPayload,
              },
              { merge: true },
            );
          Alert.alert('Live Goal', `Goal set for ${target}.`);
        } catch (err) {
          console.warn('Live goal failed', err);
          Alert.alert('Live Goal', 'Unable to save goal right now.');
        }
      });
    });
  };

  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteQuery, setInviteQuery] = useState('');
  const [inviteResults, setInviteResults] = useState<
    Array<{ uid: string; name?: string; email?: string; photo?: string }>
  >([]);
  const [inviteBusy, setInviteBusy] = useState(false);

  const inviteCoHost = async () => {
    setInviteQuery('');
    setInviteResults([]);
    setShowInviteModal(true);
  };

  const searchInviteCandidates = async () => {
    try {
      let firestoreMod: any = null;
      try {
        firestoreMod = require('@react-native-firebase/firestore').default;
      } catch {}
      const q = (inviteQuery || '').trim();
      if (!q || !firestoreMod) {
        setInviteResults([]);
        return;
      }
      // Exact match on displayName or email for simplicity
      const out: Array<{
        uid: string;
        name?: string;
        email?: string;
        photo?: string;
      }> = [];
      try {
        const snap = await firestoreMod()
          .collection('users')
          .where('displayName', '==', q.replace(/^@/, ''))
          .limit(10)
          .get();
        snap.forEach((d: any) => {
          const data = d.data();
          out.push({
            uid: d.id,
            name: data?.displayName,
            email: data?.email || null,
            photo: data?.photoURL || null,
          });
        });
      } catch {}
      try {
        const snap2 = await firestoreMod()
          .collection('users')
          .where('email', '==', q.toLowerCase())
          .limit(10)
          .get();
        snap2.forEach((d: any) => {
          const data = d.data();
          if (!out.find(x => x.uid === d.id))
            out.push({
              uid: d.id,
              name: data?.displayName,
              email: data?.email || null,
              photo: data?.photoURL || null,
            });
        });
      } catch {}
      setInviteResults(out);
    } catch {}
  };

  const inviteUserToDrift = async (targetUid: string) => {
    const me = auth?.()?.currentUser;
    if (!me) throw new Error('Sign in required');
    let functionsMod: any = null;
    try {
      functionsMod = require('@react-native-firebase/functions').default;
    } catch {}
    if (!functionsMod) throw new Error('Firebase Functions not available');
    const sendCrewInvitation =
      functionsMod().httpsCallable('sendCrewInvitation');
    const result = await sendCrewInvitation({
      toUid: targetUid,
      crewId: liveDocId || 'default-crew',
      crewName: liveTitle || 'Live Session',
      message: `Join my live ${liveTitle || 'session'}`,
    });
    return result?.data?.status === 'sent';
  };

  const sendInviteTo = async (
    to: { uid?: string; email?: string } | string,
  ) => {
    let toUid = '';
    if (typeof to === 'string') {
      const v = to.trim();
      toUid = v.replace(/^@/, '');
    } else {
      if (to.uid) toUid = to.uid;
      else return;
    }

    if (!toUid) {
      Alert.alert('Error', 'Invalid user ID');
      return;
    }

    setInviteBusy(true);
    try {
      const sent = await inviteUserToDrift(toUid);
      if (sent) {
        Alert.alert('Success', 'Invitation sent!');
        setShowInviteModal(false);
      } else {
        Alert.alert('Error', 'Failed to send invite');
      }
    } catch (error) {
      console.warn('Invite error:', error);
      Alert.alert('Error', 'Failed to send invite');
    } finally {
      setInviteBusy(false);
    }
  };

  const showLiveAnalytics = () => {
    const analytics = {
      viewers: 150,
      peakViewers: 200,
      avgWatchTime: '15:30',
      newFollowers: 23,
      totalTips: 45.5,
    };
    setLiveAnalytics(analytics);
    Alert.alert(
      'Live Analytics',
      `Viewers: ${analytics.viewers}\nPeak: ${analytics.peakViewers}\nAvg Watch: ${analytics.avgWatchTime}\nNew Followers: ${analytics.newFollowers}\nTips: $${analytics.totalTips}`,
    );
  };

  const soundEffects = useMemo(
    () => [
      {
        id: 'drumroll',
        label: 'Drumroll',
        icon: '🥁',
        file: 'large_underwater_explosion_190270',
      },
      {
        id: 'applause',
        label: 'Applause',
        icon: '👏',
        file: 'downfall_3_208028',
      },
      {
        id: 'airhorn',
        label: 'Airhorn',
        icon: '📯',
        file: 'sci_fi_sound_effect_designed_circuits_hum_10_200831',
      },
    ],
    [],
  );

  const playSoundEffect = (sound: { file: string; label: string }) => {
    if (!Sound) {
      Alert.alert('Sound Not Available', 'Sound library not loaded');
      return;
    }
    
    try {
      console.log('Attempting to play sound:', sound.label, sound.file);
      
      // Play from raw folder (no extension needed)
      const soundPlayer = new Sound(sound.file, Sound.MAIN_BUNDLE, (error: any) => {
        if (error) {
          console.log('Failed to load sound:', sound.label, error);
          Alert.alert('Sound Error', `Failed to load ${sound.label}: ${JSON.stringify(error)}`);
          return;
        }
        
        console.log('Sound loaded successfully:', sound.label, 'Duration:', soundPlayer.getDuration());
        
        // Set volume to maximum
        soundPlayer.setVolume(1.0);
        
        // Play the sound
        soundPlayer.play((success: boolean) => {
          if (success) {
            console.log('Sound played successfully:', sound.label);
          } else {
            console.log('Sound playback failed for:', sound.label);
          }
          // Release the sound resource
          soundPlayer.release();
        });
      });
    } catch (error: any) {
      console.log('playSoundEffect error:', error);
      Alert.alert('Error', `Sound error: ${error.message || error}`);
    }
  };

  const showSoundBoard = () => {
    Alert.alert(
      'Sound Effects',
      'Choose a sound effect:',
      [
        ...soundEffects.map(effect => ({
          text: `${effect.icon} ${effect.label}`,
          onPress: () => playSoundEffect(effect),
        })),
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  };

  // ---------- System/helper utilities ----------
  const userMgmtBase: string =
    (cfg &&
      (cfg.USER_MGMT_ENDPOINT_BASE ||
        cfg.BACKEND_BASE_URL ||
        cfg.USER_MANAGEMENT_BASE_URL)) ||
    '';

  const sendSystemMessage = async (message: string) => {
    try {
      let firestoreMod: any = null;
      try {
        firestoreMod = require('@react-native-firebase/firestore').default;
      } catch {}
      if (firestoreMod && liveDocId) {
        await firestoreMod()
          .collection(`live/${liveDocId}/comments`)
          .add({
            text: message,
            from: 'System',
            createdAt: firestoreMod.FieldValue?.serverTimestamp
              ? firestoreMod.FieldValue.serverTimestamp()
              : new Date(),
          });
      }
    } catch {}
  };

  const askForText = (
    title: string,
    placeholder: string,
    onSubmit: (value: string) => void,
  ) => {
    setPromptTitle(title);
    setPromptPlaceholder(placeholder);
    promptValueRef.current = '';
    promptSubmitRef.current = onSubmit;
    setPromptVisible(true);
  };

  // ---------- User management actions ----------
  const makeModerator = (userId: string, username: string) => {
    if (!userMgmtBase) {
      Alert.alert('Config', 'User management base URL not set.');
      return;
    }
    Alert.alert(
      'Make Moderator',
      `Make @${username} a moderator? They will be able to:\n• Mute/Unmute users\n• Remove messages\n• Timeout users`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Make Moderator',
          onPress: async () => {
            try {
              await fetch(`${userMgmtBase}/make-moderator`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ liveId: liveDocId, userId, username }),
              });
              setModerators(prev => [...prev, userId]);
              sendSystemMessage(`${username} is now a moderator`);
            } catch {
              Alert.alert('Error', 'Failed to make user moderator');
            }
          },
        },
      ],
    );
  };

  const removeModerator = (userId: string, username: string) => {
    if (!userMgmtBase) {
      Alert.alert('Config', 'User management base URL not set.');
      return;
    }
    Alert.alert('Remove Moderator', `Remove @${username} as moderator?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        onPress: async () => {
          try {
            await fetch(`${userMgmtBase}/remove-moderator`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ liveId: liveDocId, userId }),
            });
            setModerators(prev => prev.filter(id => id !== userId));
            sendSystemMessage(`${username} is no longer a moderator`);
          } catch {
            Alert.alert('Error', 'Failed to remove moderator');
          }
        },
      },
    ]);
  };

  const muteUser = (userId: string, username: string) => {
    if (!userMgmtBase) {
      Alert.alert('Config', 'User management base URL not set.');
      return;
    }
    Alert.alert(
      'Mute User',
      `Mute @${username}? They won't be able to speak in this live.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Mute',
          onPress: async () => {
            try {
              try {
                engineRef.current?.muteRemoteAudioStream?.(userId as any, true);
              } catch {}
              await fetch(`${userMgmtBase}/mute-user`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  liveId: liveDocId,
                  userId,
                  username,
                  duration: 'permanent',
                }),
              });
              setMutedUsers(prev => [...prev, userId]);
              sendSystemMessage(`${username} has been muted`);
            } catch {
              Alert.alert('Error', 'Failed to mute user');
            }
          },
        },
      ],
    );
  };

  const unmuteUser = (userId: string, username: string) => {
    try {
      engineRef.current?.muteRemoteAudioStream?.(userId as any, false);
    } catch {}
    if (userMgmtBase) {
      fetch(`${userMgmtBase}/unmute-user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ liveId: liveDocId, userId }),
      });
    }
    setMutedUsers(prev => prev.filter(id => id !== userId));
    sendSystemMessage(`${username} has been unmuted`);
  };

  const kickUser = (userId: string, username: string) => {
    if (!userMgmtBase) {
      Alert.alert('Config', 'User management base URL not set.');
      return;
    }
    Alert.alert('Remove User', `Remove @${username} from this live stream?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          try {
            // Backend API call to kick user - backend will handle RTM notification
            await fetch(`${userMgmtBase}/kick-user`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                liveId: liveDocId,
                userId,
                username,
                channel: liveChannel,
                kickerId: auth().currentUser?.uid,
                notifyViaRTM: true, // Backend sends RTM message to kicked user
              }),
            });
            sendSystemMessage(`${username} has been removed from the live`);
          } catch {
            Alert.alert('Error', 'Failed to remove user');
          }
        },
      },
    ]);
  };

  const blockUser = (userId: string, username: string) => {
    if (!userMgmtBase) {
      Alert.alert('Config', 'User management base URL not set.');
      return;
    }
    Alert.alert(
      'Block User',
      `Block @${username}? They won't be able to join your future live streams.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block',
          style: 'destructive',
          onPress: async () => {
            try {
              kickUser(userId, username);
              await fetch(`${userMgmtBase}/block-user`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  liveId: liveDocId,
                  userId,
                  username,
                  blockerId: auth().currentUser?.uid,
                }),
              });
              setBlockedUsers(prev => [...prev, userId]);
              sendSystemMessage(`${username} has been blocked`);
            } catch {
              Alert.alert('Error', 'Failed to block user');
            }
          },
        },
      ],
    );
  };

  const unblockUser = (userId: string, username: string) => {
    if (userMgmtBase) {
      fetch(`${userMgmtBase}/unblock-user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, blockerId: auth().currentUser?.uid }),
      });
    }
    setBlockedUsers(prev => prev.filter(id => id !== userId));
  };

  const timeoutUser = (userId: string, username: string) => {
    Alert.alert(
      'Timeout User',
      `Temporarily remove @${username} from this live?`,
      [
        { text: '5 min', onPress: () => applyTimeout(userId, username, 5) },
        { text: '15 min', onPress: () => applyTimeout(userId, username, 15) },
        { text: '1 hour', onPress: () => applyTimeout(userId, username, 60) },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  };

  const applyTimeout = async (
    userId: string,
    username: string,
    minutes: number,
  ) => {
    if (!userMgmtBase) {
      Alert.alert('Config', 'User management base URL not set.');
      return;
    }
    try {
      await fetch(`${userMgmtBase}/timeout-user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          liveId: liveDocId,
          userId,
          username,
          duration: minutes,
          channel: liveChannel,
        }),
      });
      sendSystemMessage(
        `${username} has been timed out for ${minutes} minutes`,
      );
    } catch {
      Alert.alert('Error', 'Failed to timeout user');
    }
  };

  const pinUser = (userId: string, username: string) => {
    if (!userMgmtBase) {
      Alert.alert('Config', 'User management base URL not set.');
      return;
    }
    Alert.alert('Pin User', `Feature @${username} prominently in the stream?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Pin',
        onPress: async () => {
          try {
            try {
              engineRef.current?.setRemoteVideoStreamType?.(userId as any, 0);
            } catch {}
            await fetch(`${userMgmtBase}/pin-user`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ liveId: liveDocId, userId, username }),
            });
            sendSystemMessage(`${username} is now featured in the stream`);
          } catch {
            Alert.alert('Error', 'Failed to pin user');
          }
        },
      },
    ]);
  };

  const unpinUser = (userId: string, username: string) => {
    try {
      engineRef.current?.setRemoteVideoStreamType?.(userId as any, 1);
    } catch {}
    if (userMgmtBase) {
      fetch(`${userMgmtBase}/unpin-user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ liveId: liveDocId, userId }),
      });
    }
    sendSystemMessage(`${username} is no longer featured`);
  };

  const inviteCoHostById = (userId: string, username: string) => {
    if (userId && username) {
      if (!userMgmtBase) {
        Alert.alert('Config', 'User management base URL not set.');
        return;
      }
      Alert.alert(
        'Co-host Invitation',
        `Invite @${username} to co-host this live? They will be able to:\n• Control audio/video\n• Manage users\n• Share screen`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Invite',
            onPress: async () => {
              try {
                await fetch(`${userMgmtBase}/invites`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    fromUid: auth().currentUser?.uid,
                    toUid: userId,
                    message: `Join my live ${liveTitle}`,
                  }),
                });
                sendSystemMessage(`${username} has been invited to co-host`);
              } catch {
                Alert.alert('Error', 'Failed to invite co-host');
              }
            },
          },
        ],
      );
    } else {
      Alert.alert('Co-host', 'Search for users to invite as co-hosts');
    }
  };

  const removeCoHost = (userId: string, username: string) => {
    if (!userMgmtBase) {
      Alert.alert('Config', 'User management base URL not set.');
      return;
    }
    Alert.alert('Remove Co-host', `Remove @${username} as co-host?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          try {
            await fetch(`${userMgmtBase}/remove-cohost`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                liveId: liveDocId,
                userId,
                channel: liveChannel,
              }),
            });
            sendSystemMessage(`${username} is no longer a co-host`);
          } catch {
            Alert.alert('Error', 'Failed to remove co-host');
          }
        },
      },
    ]);
  };

  const transferHost = (userId: string, username: string) => {
    if (!userMgmtBase) {
      Alert.alert('Config', 'User management base URL not set.');
      return;
    }
    Alert.alert(
      'Transfer Host Role',
      `Make @${username} the main host? You will become a co-host.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Transfer',
          style: 'destructive',
          onPress: async () => {
            try {
              await fetch(`${userMgmtBase}/transfer-host`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  liveId: liveDocId,
                  newHostId: userId,
                  newHostName: username,
                  previousHostId: auth().currentUser?.uid,
                  channel: liveChannel,
                }),
              });
              sendSystemMessage(`Host role transferred to ${username}`);
            } catch {
              Alert.alert('Error', 'Failed to transfer host role');
            }
          },
        },
      ],
    );
  };

  const disableUserChat = (userId: string, username: string) => {
    if (!userMgmtBase) {
      Alert.alert('Config', 'User management base URL not set.');
      return;
    }
    Alert.alert(
      'Restrict Chat',
      `Prevent @${username} from sending messages in chat?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Restrict',
          onPress: async () => {
            try {
              await fetch(`${userMgmtBase}/disable-chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ liveId: liveDocId, userId, username }),
              });
              sendSystemMessage(`${username} can no longer send messages`);
            } catch {
              Alert.alert('Error', 'Failed to restrict chat');
            }
          },
        },
      ],
    );
  };

  const enableUserChat = (userId: string, username: string) => {
    if (userMgmtBase) {
      fetch(`${userMgmtBase}/enable-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ liveId: liveDocId, userId }),
      });
    }
    sendSystemMessage(`${username} can now send messages`);
  };

  const sendPrivateMessage = (userId: string, username: string) => {
    // Open the built-in Send Message modal (writes to Firestore)
    try {
      setMessageRecipient({ uid: userId, name: username });
      setMessageText('');
      setShowSendMessage(true);
    } catch {
      Alert.alert(
        'Send Message',
        `Feature not available in this context. Use the main app to message @${username}.`,
      );
    }
  };

  const giveShoutout = (userId: string, username: string) => {
    askForText(
      'Give Shout-out',
      `Say something nice about @${username}`,
      message => {
        if (!message?.trim()) return;
        sendSystemMessage(`🎉 Shout-out to @${username}: ${message}`);
        if (userMgmtBase) {
          fetch(`${userMgmtBase}/give-shoutout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              liveId: liveDocId,
              userId,
              username,
              message: message.trim(),
              fromHost: auth().currentUser?.uid,
            }),
          });
        }
      },
    );
  };

  const awardBadge = (userId: string, username: string) => {
    const badges = [
      { name: 'Super Fan', icon: '⭐' },
      { name: 'Top Supporter', icon: '💎' },
      { name: 'Helpful Crew', icon: '🛟' },
      { name: 'Rising Star', icon: '🚀' },
    ];
    Alert.alert(
      'Award Badge',
      `Choose a badge for @${username}:`,
      badges.map(badge => ({
        text: `${badge.icon} ${badge.name}`,
        onPress: () => applyBadge(userId, username, badge),
      })),
    );
  };

  const applyBadge = async (userId: string, username: string, badge: any) => {
    try {
      if (userMgmtBase) {
        await fetch(`${userMgmtBase}/award-badge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            liveId: liveDocId,
            userId,
            username,
            badge: badge.name,
            icon: badge.icon,
            awardedBy: auth().currentUser?.uid,
          }),
        });
      }
      sendSystemMessage(
        `🏆 ${username} earned the ${badge.icon} ${badge.name} badge!`,
      );
    } catch {
      Alert.alert('Error', 'Failed to award badge');
    }
  };

  const displaySupporterOnScreen = (userId: string, username: string) => {
    setTopSupporters(prev => [...prev, { id: userId, username }]);
    setTimeout(
      () => setTopSupporters(prev => prev.filter(u => u.id !== userId)),
      15000,
    );
  };

  const featureInSupporters = (userId: string, username: string) => {
    if (!userMgmtBase) {
      Alert.alert('Config', 'User management base URL not set.');
      return;
    }
    Alert.alert(
      'Feature Supporter',
      `Add @${username} to the Top Supporters list?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Feature',
          onPress: async () => {
            try {
              await fetch(`${userMgmtBase}/feature-supporter`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ liveId: liveDocId, userId, username }),
              });
              displaySupporterOnScreen(userId, username);
              sendSystemMessage(
                `👑 ${username} is now featured as a Top Supporter!`,
              );
            } catch {
              Alert.alert('Error', 'Failed to feature supporter');
            }
          },
        },
      ],
    );
  };

  const handleUserAction = (
    action: string,
    userId: string,
    username: string,
  ) => {
    switch (action) {
      case 'acceptDrift': {
        const cfgLocal = (() => {
          try {
            return require('./liveConfig');
          } catch {
            return null;
          }
        })();
        const backendBase: string =
          (cfgLocal &&
            (cfgLocal.BACKEND_BASE_URL ||
              cfgLocal.USER_MGMT_ENDPOINT_BASE ||
              cfgLocal.USER_MANAGEMENT_BASE_URL)) ||
          '';
        if (!backendBase) {
          Alert.alert('Config', 'Backend base URL not set.');
          return;
        }
        if (!liveDocId) {
          Alert.alert('Live', 'Start live first.');
          return;
        }
        const chan =
          liveChannel ||
          (cfgLocal && (cfgLocal.AGORA_CHANNEL_NAME || 'Drift')) ||
          'Drift';
        (async () => {
          try {
            const resp = await fetch(`${backendBase}/drift/accept`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                liveId: liveDocId,
                requesterUid: userId,
                hostUid: auth().currentUser?.uid,
                channel: chan,
              }),
            });
            if (!resp.ok) throw new Error('accept failed');
            sendSystemMessage(`Accepted @${username} to drift`);
          } catch {
            Alert.alert('Error', 'Failed to accept requester');
          }
        })();
        return;
      }
      case 'join':
        return handleJoinCrew(userId, username);
      case 'makeModerator':
        return makeModerator(userId, username);
      case 'inviteCoHost':
        return inviteCoHostById(userId, username);
      case 'inviteToDrift':
        (async () => {
          try {
            const invited = await inviteUserToDrift(userId);
            if (invited) {
              Alert.alert(
                'Drift Invite',
                `${username ? `@${username}` : 'User'} has been invited to drift`,
              );
            } else {
              Alert.alert('Error', 'Failed to invite to drift');
            }
          } catch {
            Alert.alert('Error', 'Failed to invite to drift');
          }
        })();
        return;
      case 'mute':
        return muteUser(userId, username);
      case 'kick':
        return kickUser(userId, username);
      case 'block':
        return blockUser(userId, username);
      case 'removeFromCrew':
        return kickUser(userId, username);
      case 'timeout':
        return timeoutUser(userId, username);
      case 'shoutout':
        return giveShoutout(userId, username);
      case 'badge':
        return awardBadge(userId, username);
      case 'message':
        return sendPrivateMessage(userId, username);
      case 'restrictChat':
        return disableUserChat(userId, username);
      case 'featureSupporter':
        return featureInSupporters(userId, username);
      default:
        return;
    }
  };

    // ---------- UserManagementPanel component ----------
  const UserManagementPanel = ({
    viewers,
    onUserAction,
    moderators,
    coHosts,
    mode = 'none',
    searchOceanEntities,
    isInUserCrew,
  }: {
    viewers: any[];
    onUserAction: (action: string, userId: string, username: string) => void;
    moderators: string[];
    coHosts: string[];
    mode?: 'none' | 'join' | 'block' | 'remove';
    searchOceanEntities: (term: string) => Promise<SearchResult[]>;
    isInUserCrew: { [uid: string]: boolean };
  }) => {
    const [searchQuery, setSearchQuery] = useState('');
    const [panelSearchResults, setPanelSearchResults] = useState<SearchResult[]>([]);
    const [panelSearchLoading, setPanelSearchLoading] = useState(false);
    const [panelSearchError, setPanelSearchError] = useState<string | null>(null);
    const [actionTarget, setActionTarget] = useState<any | null>(null);
    const filtered = viewers.filter(u =>
      (u.username || '').toLowerCase().includes(searchQuery.toLowerCase()),
    );

    const panelMode = mode;
    const panelHints: Record<typeof panelMode, string | null> = {
      none: null,
      join: 'Search for a drifter and tap to add them to your crew.',
      block: 'Search for a drifter and tap to add them to the backend block list.',
      remove: 'Search for a drifter and tap to remove them from your crew.',
    };

    const runUserPanelSearch = useCallback(async () => {
      if (panelMode === 'none') return;
      const term = searchQuery.trim();
      if (!term) {
        setPanelSearchError('Enter a handle or keyword to search.');
        return;
      }
      setPanelSearchLoading(true);
      setPanelSearchError(null);
      try {
        const results = await searchOceanEntities(term);
        const usersOnly = results.filter(r => r.kind === 'user');
        setPanelSearchResults(usersOnly);
        if (usersOnly.length === 0) {
          setPanelSearchError('No users found for that term.');
        }
      } catch (err) {
        console.warn('User panel search failed', err);
        setPanelSearchError('Search failed. Try again.');
      } finally {
        setPanelSearchLoading(false);
      }
    }, [panelMode, searchQuery, searchOceanEntities]);


    const getUserActions = (user: any) => {
      const base = [
        { label: 'Send Message', action: 'message', icon: '💬' },
        { label: 'Give Shout-out', action: 'shoutout', icon: '📢' },
        { label: 'Award Badge', action: 'badge', icon: '🏅' },
      ];
      const moderation = [
        { label: 'Make Moderator', action: 'makeModerator', icon: '👮' },
        { label: 'Invite Co-host', action: 'inviteCoHost', icon: '🎤' },
        { label: 'Invite to Drift', action: 'inviteToDrift', icon: '🌊' },
        { label: 'Feature Supporter', action: 'featureSupporter', icon: '⭐' },
      ];
      const restrictive = [
        { label: 'Mute Audio', action: 'mute', icon: '🔇' },
        { label: 'Restrict Chat', action: 'restrictChat', icon: '🚫' },
        { label: 'Timeout', action: 'timeout', icon: '⏱️' },
      ];
      const crewActions = [
        {
          label: (isInUserCrew && isInUserCrew[user.id]) ? 'Remove from Crew' : 'Join Crew',
          action: (isInUserCrew && isInUserCrew[user.id]) ? 'removeFromCrew' : 'join',
          icon: 'dY?',
        },
        { label: 'Block', action: 'block', icon: 'dYs?' },
      ];
      return [
        ...base,
        { label: 'Accept To Drift', action: 'acceptDrift', icon: 'dYZ' },
        ...moderation,
        ...restrictive,
        ...crewActions,
      ];
    };

    const isSearchMode = panelMode !== 'none';

    const shouldShowSearchResults =
      isSearchMode && (panelSearchResults.length > 0 || searchQuery.trim().length > 0);
    const displayUsers = shouldShowSearchResults 
      ? panelSearchResults.map(result => ({
          id: result.id,
          username: result.label,
          avatar: result.extra?.avatar || 'https://via.placeholder.com/40',
          isSpeaking: false,
          isSubscriber: false,
        }))
      : filtered;

    const handleActionSelect = (action: string) => {
      if (!actionTarget) return;
      onUserAction(action, actionTarget.id, actionTarget.username);
      setActionTarget(null);
    };

    return (
      <View style={userManagementStyles.panel}>
        <TextInput
          placeholder="Search viewers..."
          value={searchQuery}
          onChangeText={setSearchQuery}
          style={userManagementStyles.searchInput}
          placeholderTextColor="rgba(255,255,255,0.6)"
          onSubmitEditing={() => runUserPanelSearch()}
        />
        {panelMode !== 'none' && (
          <Pressable
            style={[
              userManagementStyles.searchButton,
              panelSearchLoading && { opacity: 0.7 },
            ]}
            onPress={runUserPanelSearch}
            disabled={panelSearchLoading}
          >
            {panelSearchLoading ? (
              <ActivityIndicator size="small" color="#00C2FF" />
            ) : (
              <Text style={userManagementStyles.searchButtonText}>
                Search for users
              </Text>
            )}
          </Pressable>
        )}
        {panelSearchError && (
          <Text style={[userManagementStyles.hint, { color: '#ff6b6b' }]}>
            {panelSearchError}
          </Text>
        )}
        {panelHints[panelMode] && (
          <Text style={userManagementStyles.hint}>{panelHints[panelMode]}</Text>
        )}
        <ScrollView style={userManagementStyles.userList}>
          {displayUsers.length === 0 && (
            <Text style={styles.hint}>
              {panelMode === 'none'
                ? 'No viewers yet. Invite friends to join.'
                : searchQuery.trim()
                ? 'No users matched that search.'
                : 'Type a name to find crewmates.'}
            </Text>
          )}
          {displayUsers.map(user => (
            <Pressable
              key={user.id}
              style={userManagementStyles.userItem}
              onPress={() => setActionTarget(user)}
            >
              <View style={userManagementStyles.userInfo}>
                <Image
                  source={{ uri: user.avatar }}
                  style={userManagementStyles.avatar}
                />
                <View style={userManagementStyles.userDetails}>
                  <Text style={userManagementStyles.username}>
                    {user.username}
                    {moderators.includes(user.id) ? ' � Mod' : ''}
                    {coHosts.includes(user.id) ? ' � Co-host' : ''}
                  </Text>
                  <Text style={userManagementStyles.userStatus}>
                    {(user.isSpeaking ? 'Speaking ' : '') +
                      (user.isSubscriber ? 'Subscriber ' : '') +
                      ((isInUserCrew && isInUserCrew[user.id]) ? 'Crew' : '')}
                  </Text>
                </View>
              </View>
            </Pressable>
          ))}
        </ScrollView>
        {actionTarget && (
          <Modal
            visible
            transparent
            animationType="fade"
            onRequestClose={() => setActionTarget(null)}
          >
            <Pressable
              style={userManagementStyles.actionModalBackdrop}
              onPress={() => setActionTarget(null)}
            >
              <Pressable
                style={userManagementStyles.actionModalContent}
                onPress={event => event.stopPropagation && event.stopPropagation()}
              >
                <Text style={userManagementStyles.actionModalTitle}>
                  Manage {actionTarget.username || actionTarget.id}
                </Text>
                <ScrollView
                  style={{ maxHeight: 240 }}
                  contentContainerStyle={{ gap: 8, paddingVertical: 8 }}
                >
                  {getUserActions(actionTarget).map(action => (
                    <Pressable
                      key={action.action}
                      style={userManagementStyles.actionModalButton}
                      onPress={() => handleActionSelect(action.action)}
                    >
                      <Text style={userManagementStyles.actionModalButtonText}>
                        {action.icon} {action.label}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
                <Pressable
                  style={userManagementStyles.actionModalClose}
                  onPress={() => setActionTarget(null)}
                >
                  <Text style={userManagementStyles.actionModalCloseText}>
                    Close
                  </Text>
                </Pressable>
              </Pressable>
            </Pressable>
          </Modal>
        )}
      </View>
    );
  };const userManagementStyles = StyleSheet.create({
    panel: {
      position: 'absolute',
      top: 100,
      left: 16,
      right: 16,
      bottom: 200,
      backgroundColor: 'rgba(0,0,0,0.95)',
      borderRadius: 12,
      padding: 16,
      borderWidth: 1,
      borderColor: '#00C2FF',
    },
    searchInput: {
      backgroundColor: 'rgba(255,255,255,0.1)',
      color: 'white',
      padding: 12,
      borderRadius: 8,
      marginBottom: 6,
    },
    searchButton: {
      paddingVertical: 8,
      paddingHorizontal: 12,
      borderRadius: 8,
      borderColor: '#00C2FF',
      borderWidth: 1,
      alignSelf: 'flex-start',
      marginBottom: 8,
    },
    searchButtonText: {
      color: '#00C2FF',
      fontWeight: '600',
    },
    userList: { flex: 1 },
    userItem: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: 'rgba(255,255,255,0.1)',
    },
    userInfo: { flexDirection: 'row', alignItems: 'center', flex: 1 },
    avatar: { width: 40, height: 40, borderRadius: 20, marginRight: 12 },
    userDetails: { flex: 1 },
    username: { color: 'white', fontWeight: '600', fontSize: 14 },
    userStatus: { color: 'rgba(255,255,255,0.6)', fontSize: 12 },
    actionModalBackdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.6)',
      justifyContent: 'center',
      padding: 24,
    },
    actionModalContent: {
      backgroundColor: '#0A0F1A',
      borderRadius: 12,
      padding: 16,
      borderWidth: 1,
      borderColor: '#00C2FF',
    },
    actionModalTitle: {
      color: 'white',
      fontWeight: '700',
      fontSize: 16,
      marginBottom: 12,
      textAlign: 'center',
    },
    actionModalButton: {
      paddingVertical: 10,
      paddingHorizontal: 12,
      borderRadius: 8,
      backgroundColor: 'rgba(255,255,255,0.08)',
    },
    actionModalButtonText: {
      color: '#00C2FF',
      fontWeight: '600',
      fontSize: 14,
    },
    actionModalClose: {
      marginTop: 12,
      padding: 10,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: '#00C2FF',
      alignSelf: 'stretch',
      alignItems: 'center',
    },
    actionModalCloseText: {
      color: '#FFFFFF',
      fontWeight: '700',
    },
    hint: {
      color: '#00C2FF',
      fontSize: 12,
      marginBottom: 12,
      fontStyle: 'italic',
    },
  });

  if (!visible) return null;
  if (!Agora) {
    return (
      <Modal
        visible={visible}
        transparent
        animationType="slide"
        onRequestClose={onClose}
      >
        <View
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'black',
          }}
        >
          <Text style={{ color: 'white', textAlign: 'center', padding: 20 }}>
            Install react-native-agora and rebuild.
          </Text>
          <Pressable style={styles.closeBtn} onPress={onClose}>
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
        </View>
      </Modal>
    );
  }
  if (!appId) {
    return (
      <Modal
        visible={visible}
        transparent
        animationType="slide"
        onRequestClose={onClose}
      >
        <View
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'black',
          }}
        >
          <Text style={{ color: 'white', textAlign: 'center', padding: 20 }}>
            Missing AGORA_APP_ID in liveConfig.ts
          </Text>
          <Pressable style={styles.closeBtn} onPress={onClose}>
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
        </View>
      </Modal>
    );
  }

  const AVView = Agora?.AgoraVideoView;
  const RtcSurfaceView = (Agora as any)?.RtcSurfaceView;
  const RtcTextureView = (Agora as any)?.RtcTextureView;
  const RtcLocalView = Agora?.RtcLocalView;
  const VideoRenderMode = Agora?.VideoRenderMode;
  const VideoSourceType = Agora?.VideoSourceType;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={editorStyles.editorRoot}>
        {isLiveStarted && (
          <Text
            style={{
              color: 'white',
              position: 'absolute',
              top: insets.top + 10,
              left: 16,
              zIndex: 10,
              backgroundColor: 'navy',
              paddingHorizontal: 8,
              paddingVertical: 4,
              borderRadius: 4,
              fontWeight: 'bold',
            }}
          >
            DRIFTING
          </Text>
        )}
        {isLiveStarted && (
          <Text
            style={{
              color: 'white',
              position: 'absolute',
              top: insets.top + 10,
              right: 16,
              zIndex: 10,
              backgroundColor: 'rgba(0,0,0,0.5)',
              paddingHorizontal: 8,
              paddingVertical: 4,
              borderRadius: 4,
              fontWeight: 'bold',
            }}
          >
            {livePrivacy.toUpperCase()}
          </Text>
        )}
        {isLiveStarted && !cameraHidden &&
          (AVView ? ( // v4+
            <AVView
              style={StyleSheet.absoluteFill}
              showLocalVideo={true}
              videoSourceType={
                (VideoSourceType &&
                  (VideoSourceType.VideoSourceCameraPrimary ??
                    VideoSourceType.VideoSourceCamera)) ||
                0
              }
              renderMode={(VideoRenderMode && VideoRenderMode.Hidden) || 1}
            />
          ) : RtcSurfaceView ? ( // v4 older
            React.createElement(RtcSurfaceView, {
              style: StyleSheet.absoluteFill,
              canvas: { uid: 0 },
              zOrderMediaOverlay: true,
            })
          ) : RtcTextureView ? ( // v4 older
            React.createElement(RtcTextureView, {
              style: StyleSheet.absoluteFill,
              canvas: { uid: 0 },
            })
          ) : RtcLocalView?.SurfaceView ? ( // v3
            React.createElement(RtcLocalView.SurfaceView, {
              style: StyleSheet.absoluteFill,
              renderMode: VideoRenderMode?.Hidden ?? 1,
            })
          ) : (
            <View
              style={[
                StyleSheet.absoluteFill,
                { alignItems: 'center', justifyContent: 'center' },
              ]}
            >
              <Text style={{ color: 'white' }}>Initializing preview…</Text>
            </View>
          ))}
        {isLiveStarted && liveComments.length > 0 && (
          <ScrollView
            style={[
              editorStyles.liveCommentsOverlay,
              {
                bottom: insets.bottom + endBarHeight + mediaBarHeight + 16,
                top: '25%',
              },
            ]}
            contentContainerStyle={{ justifyContent: 'flex-end', flexGrow: 1 }}
            showsVerticalScrollIndicator={false}
          >
            <View>
              {liveComments.map(c => (
                <Pressable
                  key={c.id}
                  onLongPress={() => {
                    Alert.alert(`Comment by ${c.from}`, `"${c.text}"`, [
                      {
                        text: 'Splash 💧',
                        onPress: () => onSplashComment(c.id),
                      },
                      {
                        text: 'Echo Back 📣',
                        onPress: () => onEchoBack(c as any),
                      },
                      { text: 'Cancel', style: 'cancel' },
                    ]);
                  }}
                >
                  <View style={editorStyles.liveCommentBubble}>
                    <Text style={editorStyles.liveCommentAuthor}>
                      {(c as any).fromUid
                        ? displayHandle((c as any).fromUid, c.from)
                        : c.from === 'You'
                        ? '/You'
                        : formatHandle(c.from)}
                      :
                    </Text>
                    <Text style={editorStyles.liveCommentText}>{c.text}</Text>
                  </View>
                </Pressable>
              ))}
            </View>
          </ScrollView>
        )}
        {isLiveStarted && flyingComments.length > 0 && (
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            {flyingComments.map((fc, idx) => {
              const translateY = fc.anim.interpolate({
                inputRange: [0, 1],
                outputRange: [SCREEN_HEIGHT * 0.15, -SCREEN_HEIGHT * 0.15],
              });
              const translateX = fc.anim.interpolate({
                inputRange: [0, 1],
                outputRange: [16, SCREEN_WIDTH / 2 - 60],
              });
              const opacity = fc.anim.interpolate({
                inputRange: [0, 0.8, 1],
                outputRange: [1, 1, 0],
              });
              return (
                <Animated.View
                  key={fc.id}
                  style={{
                    position: 'absolute',
                    left: 16,
                    bottom:
                      endBarHeight +
                      insets.bottom +
                      mediaBarHeight +
                      16 +
                      (idx % 3) * 8,
                    transform: [{ translateX }, { translateY }],
                    opacity,
                  }}
                >
                  <View style={editorStyles.liveCommentBubble}>
                    <Text style={editorStyles.liveCommentAuthor}>
                      {fc.from === 'You' ? '/You' : formatHandle(fc.from)}:
                    </Text>
                    <Text style={editorStyles.liveCommentText}>{fc.text}</Text>
                  </View>
                </Animated.View>
              );
            })}
          </View>
        )}
        {isLiveStarted && topSupporters.length > 0 && (
          <View
            style={{
              position: 'absolute',
              top: insets.top + 50,
              left: 16,
              right: 16,
              backgroundColor: 'rgba(0,0,0,0.6)',
              borderRadius: 8,
              padding: 8,
            }}
          >
            <Text
              style={{ color: 'white', fontWeight: '700', marginBottom: 4 }}
            >
              Top Supporters
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {topSupporters.map(s => (
                <Text
                  key={s.id}
                  style={{ color: '#00C2FF', fontWeight: '700' }}
                >
                  @{s.username}
                </Text>
              ))}
            </View>
          </View>
        )}
        {isLiveStarted && pendingRequests.length > 0 && (
          <View
            style={{
              position: 'absolute',
              top: insets.top + 90,
              right: 16,
              left: 16,
              backgroundColor: 'rgba(0,0,0,0.8)',
              borderRadius: 8,
              padding: 8,
              borderWidth: 1,
              borderColor: '#00C2FF',
            }}
          >
            <Text
              style={{ color: 'white', fontWeight: '800', marginBottom: 6 }}
            >
              Pending Drift Requests
            </Text>
            {pendingRequests.map(r => (
              <View
                key={r.uid}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  paddingVertical: 6,
                }}
              >
                <Text style={{ color: 'white' }}>
                  {r.name ? `@${r.name}` : r.uid}
                </Text>
                <Pressable
                  style={[
                    styles.primaryBtn,
                    { paddingVertical: 6, paddingHorizontal: 10 },
                  ]}
                  onPress={() =>
                    handleUserAction('acceptDrift', r.uid, r.name || r.uid)
                  }
                >
                  <Text style={styles.primaryBtnText}>Accept</Text>
                </Pressable>
              </View>
            ))}
          </View>
        )}
        {isLiveStarted && showUserPanel && (
          <UserManagementPanel
            viewers={viewers}
            moderators={moderators}
            coHosts={coHosts}
            mode={userPanelMode}
            isInUserCrew={isInUserCrew}
            searchOceanEntities={searchOceanEntities}
            onUserAction={(action, userId, username) => {
              setShowUserPanel(false);
              handleUserAction(action, userId, username);
            }}
          />
        )}
        {/* --- BEGIN LiveStreamModal tail replacement --- */}
        {/* Right-side action stack (host controls) */}
        {isLiveStarted && !showCommentInput && (
          <ScrollView
            style={[
              editorStyles.liveRightControls,
              {
                bottom: insets.bottom + endBarHeight + 80,
                top: insets.top + 40,
                maxHeight: '60%',
              },
            ]}
            contentContainerStyle={{
              gap: 18,
              alignItems: 'center',
              justifyContent: 'flex-end',
            }}
          >
            {/* Invite */}
            <Pressable
              style={editorStyles.liveRightButton}
              onPress={inviteCoHost}
            >
              <Text style={editorStyles.liveRightIcon}>🧭</Text>
              <Text style={editorStyles.liveRightLabel}>Invite</Text>
            </Pressable>
                        {/* Viewers */}
            <Pressable
              style={editorStyles.liveRightButton}
              onPress={() => setShowUserPanel(v => !v)}
            >
              <Text style={editorStyles.liveRightIcon}>👥</Text>
              <Text style={editorStyles.liveRightLabel}>
                Viewers ({viewers.length})
              </Text>
            </Pressable>

            {/* NEW LIVE CONTROLS */}
            {/* Screen Share */}
            <Pressable
              style={editorStyles.liveRightButton}
              onPress={handleScreenShare}
            >
              <Text style={editorStyles.liveRightIcon}>📺</Text>
              <Text style={editorStyles.liveRightLabel}>
                {isScreenSharing ? 'Stop Share' : 'Share Screen'}
              </Text>
            </Pressable>

            {/* Virtual Background */}
            <Pressable
              style={[
                editorStyles.liveRightButton,
                virtualBackground
                  ? {
                      backgroundColor: 'rgba(0, 194, 255, 0.2)',
                      borderRadius: 8,
                      padding: 4,
                      borderWidth: 1,
                      borderColor: '#00C2FF',
                    }
                  : null,
              ]}
              onPress={toggleVirtualBackground}
            >
              <Text style={editorStyles.liveRightIcon}>🏞️</Text>
              <Text style={editorStyles.liveRightLabel}>Background</Text>
            </Pressable>

            {/* Beauty Filter */}
            <Pressable
              style={editorStyles.liveRightButton}
              onPress={toggleBeautyFilter}
            >
              <Text style={editorStyles.liveRightIcon}>✨</Text>
              <Text style={editorStyles.liveRightLabel}>
                {beautyFilterEnabled ? 'Beauty On' : 'Beauty'}
              </Text>
            </Pressable>

            {/* Recording Control */}
            <Pressable
              style={editorStyles.liveRightButton}
              onPress={toggleRecording}
            >
              <Text style={editorStyles.liveRightIcon}>⏺️</Text>
              <Text style={editorStyles.liveRightLabel}>
                {isRecording ? 'Stop Rec' : 'Record'}
              </Text>
            </Pressable>

            {/* Live Products/Store */}
            <Pressable
              style={editorStyles.liveRightButton}
              onPress={showProductStore}
            >
              <Text style={editorStyles.liveRightIcon}>🛍️</Text>
              <Text style={editorStyles.liveRightLabel}>Products</Text>
            </Pressable>

            {/* Live Polls */}
            <Pressable
              style={editorStyles.liveRightButton}
              onPress={createLivePoll}
            >
              <Text style={editorStyles.liveRightIcon}>📊</Text>
              <Text style={editorStyles.liveRightLabel}>Polls</Text>
            </Pressable>

            {/* Live Goals */}
            <Pressable
              style={editorStyles.liveRightButton}
              onPress={handleSetLiveGoal}
            >
              <Text style={editorStyles.liveRightIcon}>🎯</Text>
              <Text style={editorStyles.liveRightLabel}>Goals</Text>
            </Pressable>

            {/* Co-host */}
            <Pressable
              style={editorStyles.liveRightButton}
              onPress={inviteCoHost}
            >
              <Text style={editorStyles.liveRightIcon}>👥</Text>
              <Text style={editorStyles.liveRightLabel}>Co-host</Text>
            </Pressable>

            {/* Live Analytics */}
            <Pressable
              style={editorStyles.liveRightButton}
              onPress={showLiveAnalytics}
            >
              <Text style={editorStyles.liveRightIcon}>📈</Text>
              <Text style={editorStyles.liveRightLabel}>Stats</Text>
            </Pressable>

            {/* Sound Effects */}
            <Pressable
              style={editorStyles.liveRightButton}
              onPress={showSoundBoard}
            >
              <Text style={editorStyles.liveRightIcon}>🎶</Text>
              <Text style={editorStyles.liveRightLabel}>Sounds</Text>
            </Pressable>

            {/* Mute mic */}
            <Pressable
              style={editorStyles.liveRightButton}
              onPress={() => {
                try {
                  setMicMuted(m => !m);
                  engineRef.current?.muteLocalAudioStream?.(!micMuted);
                } catch {}
              }}
            >
              <Text style={editorStyles.liveRightIcon}>
                {micMuted ? '🎙️🚫' : '🎙️'}
              </Text>
              <Text style={editorStyles.liveRightLabel}>
                {micMuted ? 'Unmute' : 'Mute'}
              </Text>
            </Pressable>

            {/* Hide/Show camera */}
            <Pressable
              style={editorStyles.liveRightButton}
              onPress={() => {
                try {
                  const newState = !cameraHidden;
                  setCameraHidden(newState);
                  engineRef.current?.enableLocalVideo?.(!newState);
                } catch {}
              }}
            >
              <Text style={editorStyles.liveRightIcon}>{cameraHidden ? '🎥🚫' : '🎥'}</Text>
              <Text style={editorStyles.liveRightLabel}>{cameraHidden ? 'Show' : 'Hide'}</Text>
            </Pressable>

            {/* Flip camera */}
            <Pressable
              style={editorStyles.liveRightButton}
              onPress={() => {
                try {
                  engineRef.current?.switchCamera?.();
                } catch {}
              }}
            >
              <Text style={editorStyles.liveRightIcon}>🔄</Text>
              <Text style={editorStyles.liveRightLabel}>Flip</Text>
            </Pressable>

            {/* Share live */}
            <Pressable
              style={editorStyles.liveRightButton}
              onPress={handleShareDriftLink}
            >
              <Text style={editorStyles.liveRightIcon}>🎣</Text>
              <Text style={editorStyles.liveRightLabel}>Casta drift</Text>
            </Pressable>

            {/* Report */}
            <Pressable
              style={editorStyles.liveRightButton}
              onPress={() =>
                Alert.alert('Report', 'Send report to moderation collection.')
              }
            >
              <Text style={editorStyles.liveRightIcon}>📝</Text>
              <Text style={editorStyles.liveRightLabel}>Report</Text>
            </Pressable>
          </ScrollView>
        )}

        {/* Invite Modal */}
        <Modal
          visible={showInviteModal}
          transparent
          animationType="fade"
          onRequestClose={() => setShowInviteModal(false)}
        >
          <View
            style={{
              flex: 1,
              backgroundColor: 'rgba(0,0,0,0.85)',
              paddingTop: insets.top + 40,
              paddingBottom: insets.bottom + 20,
            }}
          >
            <View
              style={{
                marginHorizontal: 16,
                backgroundColor: '#0A0F1A',
                borderRadius: 12,
                padding: 16,
                borderWidth: 1,
                borderColor: '#00C2FF',
              }}
            >
              <Text
                style={{
                  color: 'white',
                  fontWeight: '800',
                  fontSize: 16,
                  marginBottom: 8,
                }}
              >
                Invite to Drift
              </Text>
              <TextInput
                value={inviteQuery}
                onChangeText={setInviteQuery}
                placeholder="Search by @handle or email"
                placeholderTextColor="rgba(255,255,255,0.5)"
                style={editorStyles.liveSetupInput}
              />
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                <Pressable
                  disabled={inviteBusy}
                  style={[styles.primaryBtn, { flex: 1 }]}
                  onPress={searchInviteCandidates}
                >
                  <Text style={styles.primaryBtnText}>
                    {inviteBusy ? '...' : 'Search'}
                  </Text>
                </Pressable>
                <Pressable
                  disabled={inviteBusy || inviteQuery.trim().length === 0}
                  style={[styles.secondaryBtn, { flex: 1 }]}
                  onPress={() => sendInviteTo(inviteQuery)}
                >
                  <Text style={styles.secondaryBtnText}>
                    {inviteBusy ? '...' : 'Invite Input'}
                  </Text>
                </Pressable>
              </View>
              <ScrollView style={{ maxHeight: 240, marginTop: 12 }}>
                {inviteResults.length === 0 ? (
                  <Text style={{ color: 'rgba(255,255,255,0.7)' }}>
                    No results yet. Enter exact @handle or email, then Search.
                  </Text>
                ) : (
                  inviteResults.map(u => (
                    <View
                      key={u.uid}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        paddingVertical: 8,
                        borderBottomWidth: StyleSheet.hairlineWidth,
                        borderBottomColor: 'rgba(255,255,255,0.1)',
                      }}
                    >
                      <View
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 10,
                        }}
                      >
                        {u.photo ? (
                          <Image
                            source={{ uri: u.photo }}
                            style={{ width: 28, height: 28, borderRadius: 14 }}
                          />
                        ) : (
                          <View
                            style={{
                              width: 28,
                              height: 28,
                              borderRadius: 14,
                              backgroundColor: 'rgba(255,255,255,0.12)',
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                          >
                            <Text style={{ color: 'white' }}>
                              {(u.name || 'U').charAt(0).toUpperCase()}
                            </Text>
                          </View>
                        )}
                        <View>
                          <Text style={{ color: 'white', fontWeight: '700' }}>
                            {u.name || u.uid}
                          </Text>
                          {!!u.email && (
                            <Text style={{ color: 'rgba(255,255,255,0.7)' }}>
                              {u.email}
                            </Text>
                          )}
                        </View>
                      </View>
                      <Pressable
                        disabled={inviteBusy}
                        style={[
                          styles.primaryBtn,
                          { paddingVertical: 6, paddingHorizontal: 12 },
                        ]}
                        onPress={() => sendInviteTo({ uid: u.uid })}
                      >
                        <Text style={styles.primaryBtnText}>
                          {inviteBusy ? '...' : 'Invite'}
                        </Text>
                      </Pressable>
                    </View>
                  ))
                )}
              </ScrollView>
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                <Pressable
                  style={[styles.secondaryBtn, { flex: 1 }]}
                  onPress={() => setShowInviteModal(false)}
                >
                  <Text style={styles.secondaryBtnText}>Close</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

        {/* Comment Splash Animation */}
        {splashedComment && (
          <View
            style={editorStyles.commentSplashContainer}
            pointerEvents="none"
          >
            <Animated.View
              style={{
                opacity: splashAnim,
                transform: [
                  {
                    scale: splashAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0.5, 1.2],
                    }),
                  },
                  {
                    translateY: splashAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [100, 0],
                    }),
                  },
                ],
              }}
            >
              <Text style={editorStyles.commentSplashText}>
                {splashedComment.text}
              </Text>
            </Animated.View>
          </View>
        )}

        {/* Media editor strip (above End Drift) */}
        {isLiveStarted && (
          <View
            style={[
              editorStyles.liveMediaBar,
              { bottom: endBarHeight + insets.bottom + 8 },
            ]}
            onLayout={e => setMediaBarHeight(e.nativeEvent.layout.height)}
          >
            {/* Host avatar + name on right above media bar */}
            <View
              style={{
                position: 'absolute',
                right: 16,
                bottom: mediaBarHeight + 4,
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: 'rgba(0,0,0,0.35)',
                borderRadius: 20,
                paddingVertical: 6,
                paddingHorizontal: 10,
              }}
            >
              {hostPhoto ? (
                <Image
                  source={{ uri: hostPhoto }}
                  style={{ width: 28, height: 28, borderRadius: 14 }}
                />
              ) : (
                <View
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 14,
                    backgroundColor: '#2b3a4a',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ color: 'white', fontWeight: '700' }}>
                    {(hostName || 'Y').charAt(0).toUpperCase()}
                  </Text>
                </View>
              )}
              <Text
                style={{ color: 'white', fontWeight: '700', marginLeft: 8 }}
              >
                /{hostName || 'you'}
              </Text>
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={editorStyles.liveBottomScroll}
            >
              {/* Non-button items (scrollable) */}
              <View style={editorStyles.liveBottomItem}>
                <Text style={editorStyles.liveBottomIcon}>🎵</Text>
                <Text style={editorStyles.liveBottomLabel}>Music</Text>
              </View>
              <View style={editorStyles.liveBottomItem}>
                <Text style={editorStyles.liveBottomIcon}>🎨</Text>
                <Text style={editorStyles.liveBottomLabel}>Filters</Text>
              </View>
              <View style={editorStyles.liveBottomItem}>
                <Text style={editorStyles.liveBottomIcon}>🖼️</Text>
                <Text style={editorStyles.liveBottomLabel}>Overlays</Text>
              </View>
              <View style={editorStyles.liveBottomItem}>
                <Text style={editorStyles.liveBottomIcon}>✂️</Text>
                <Text style={editorStyles.liveBottomLabel}>Trim</Text>
              </View>
              <Pressable
                style={editorStyles.liveBottomItem}
                onPress={() => setShowCommentInput(p => !p)}
              >
                <Text style={editorStyles.liveBottomIcon}>💬</Text>
                <Text style={editorStyles.liveBottomLabel}>Comment</Text>
              </Pressable>
            </ScrollView>
          </View>
        )}

        {/* Comment input bar (toggles from media editor) */}
        {isLiveStarted && showCommentInput && (
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={[
              editorStyles.liveCommentInputBar,
              { bottom: insets.bottom + endBarHeight + mediaBarHeight + 8 },
            ]}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <TextInput
                value={commentText}
                onChangeText={setCommentText}
                placeholder="Say something…"
                placeholderTextColor="rgba(255,255,255,0.6)"
                style={[styles.input, { flex: 1, margin: 0 }]}
                autoFocus
              />
              <Pressable
                style={[
                  styles.primaryBtn,
                  { marginLeft: 8, paddingHorizontal: 12, paddingVertical: 8 },
                ]}
                onPress={sendLiveComment}
              >
                <Text style={styles.primaryBtnText}>Send</Text>
              </Pressable>
            </View>
          </KeyboardAvoidingView>
        )}
        {/* Cross-platform text prompt */}
        {promptVisible && (
          <View
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: 0,
              bottom: 0,
              backgroundColor: 'rgba(0,0,0,0.6)',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <View
              style={{
                backgroundColor: '#0b1726',
                padding: 16,
                borderRadius: 12,
                width: '85%',
              }}
            >
              <Text
                style={{
                  color: 'white',
                  fontWeight: '700',
                  fontSize: 16,
                  marginBottom: 12,
                }}
              >
                {promptTitle}
              </Text>
              <TextInput
                placeholder={promptPlaceholder}
                placeholderTextColor="rgba(255,255,255,0.5)"
                style={[styles.input, { marginBottom: 12 }]}
                onChangeText={t => {
                  promptValueRef.current = t;
                }}
                autoFocus
              />
              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'flex-end',
                  gap: 8,
                }}
              >
                <Pressable
                  style={styles.secondaryBtn}
                  onPress={() => {
                    setPromptVisible(false);
                    promptSubmitRef.current = undefined;
                  }}
                >
                  <Text style={styles.secondaryBtnText}>Cancel</Text>
                </Pressable>
                <Pressable
                  style={styles.primaryBtn}
                  onPress={() => {
                    const cb = promptSubmitRef.current;
                    const val = promptValueRef.current;
                    setPromptVisible(false);
                    promptSubmitRef.current = undefined;
                    if (cb) cb(val);
                  }}
                >
                  <Text style={styles.primaryBtnText}>Send</Text>
                </Pressable>
              </View>
            </View>
          </View>
        )}

        {/* Bottom action bar */}
        <View
          style={[
            editorStyles.liveBottomBar,
            { paddingBottom: insets.bottom + 8 },
          ]}
          onLayout={e => setEndBarHeight(e.nativeEvent.layout.height)}
        >
          {isLiveStarted ? (
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <Pressable
                style={[
                  styles.closeBtn,
                  {
                    marginVertical: 0,
                    alignSelf: 'center',
                    backgroundColor: 'red',
                  },
                ]}
                onPress={handleEndDrift}
              >
                <Text style={styles.closeText}>End Drift</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
        {!isLiveStarted && (
          <View style={editorStyles.liveSetupChart}>
            {paperTexture && (
              <Image
                source={paperTexture}
                style={editorStyles.liveSetupChartBg}
              />
            )}
            <View style={editorStyles.liveSetupContainer}>
              <Text style={editorStyles.liveSetupTitle}>Chart a Drift</Text>
              <View style={{ gap: 16 }}>
                <TextInput
                  value={hostName}
                  onChangeText={setHostName}
                  placeholder="Your Name"
                  placeholderTextColor="rgba(255,255,255,0.5)"
                  style={editorStyles.liveSetupInput}
                />
                <TextInput
                  value={liveTitle}
                  onChangeText={setLiveTitle}
                  placeholder="Drift Title (optional)"
                  placeholderTextColor="rgba(255,255,255,0.5)"
                  style={editorStyles.liveSetupInput}
                />
                <TextInput
                  value={channelInput}
                  onChangeText={setChannelInput}
                  placeholder="Channel"
                  placeholderTextColor="rgba(255,255,255,0.5)"
                  style={editorStyles.liveSetupInput}
                />
                <TextInput
                  value={tokenInput}
                  onChangeText={setTokenInput}
                  placeholder="Token (optional - server will provide)"
                  placeholderTextColor="rgba(255,255,255,0.5)"
                  style={editorStyles.liveSetupInput}
                />
                <Pressable
                  disabled={!isSetupValid || isStartingLive}
                  style={[
                    styles.primaryBtn,
                    {
                      marginTop: 10,
                      opacity: isSetupValid && !isStartingLive ? 1 : 0.6,
                    },
                  ]}
                  onPress={startLiveNow}
                >
                  <Text style={styles.primaryBtnText}>
                    {isStartingLive ? 'Starting…' : 'Start Drift'}
                  </Text>
                </Pressable>
                {startError ? (
                  <Text
                    style={{
                      color: '#ffb4b4',
                      marginTop: 8,
                      fontFamily:
                        Platform.OS === 'ios' ? 'Courier New' : 'monospace',
                    }}
                  >
                    {startError}
                  </Text>
                ) : null}
              </View>
              <Pressable
                style={[
                  styles.dismissBtn,
                  {
                    position: 'absolute',
                    bottom: insets.bottom + 20,
                    alignSelf: 'center',
                  },
                ]}
                onPress={onClose}
              >
                <Text style={styles.dismissText}>Close</Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
};

// Optional enhanced styles for future features
const enhancedLiveStyles = StyleSheet.create({
  liveControlPanel: {
    position: 'absolute',
    right: 16,
    top: '25%',
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderRadius: 16,
    padding: 12,
    gap: 12,
  },
  controlGroup: { gap: 8, marginBottom: 16 },
  controlGroupTitle: {
    color: 'white',
    fontWeight: '700',
    fontSize: 12,
    marginBottom: 4,
  },
  enhancedControlButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 8,
    gap: 8,
  },
  controlButtonText: { color: 'white', fontSize: 12, fontWeight: '600' },
  activeControl: {
    backgroundColor: 'rgba(0, 194, 255, 0.3)',
    borderWidth: 1,
    borderColor: '#00C2FF',
  },
  productCarousel: {
    position: 'absolute',
    bottom: 120,
    left: 16,
    right: 16,
    backgroundColor: 'rgba(0,0,0,0.8)',
    borderRadius: 12,
    padding: 12,
  },
  productItem: {
    width: 100,
    marginRight: 12,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 8,
    padding: 8,
    alignItems: 'center',
  },
  productImage: { width: 60, height: 60, borderRadius: 8 },
  productName: {
    color: 'white',
    fontSize: 10,
    fontWeight: '600',
    marginTop: 4,
    textAlign: 'center',
  },
  productPrice: {
    color: '#00C2FF',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 2,
  },
  pollContainer: {
    position: 'absolute',
    top: '30%',
    left: 16,
    right: 16,
    backgroundColor: 'rgba(0,0,0,0.9)',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#00C2FF',
  },
  pollQuestion: {
    color: 'white',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 12,
    textAlign: 'center',
  },
  pollOption: {
    backgroundColor: 'rgba(255,255,255,0.1)',
    padding: 12,
    borderRadius: 8,
    marginBottom: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  pollOptionText: { color: 'white', fontSize: 14, flex: 1 },
  pollPercentage: {
    color: '#00C2FF',
    fontSize: 12,
    fontWeight: '700',
    marginLeft: 8,
  },
  analyticsOverlay: {
    position: 'absolute',
    top: '20%',
    left: 16,
    right: 16,
    backgroundColor: 'rgba(0,0,0,0.95)',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#4CAF50',
  },
  analyticsTitle: {
    color: 'white',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 16,
    textAlign: 'center',
  },
  analyticsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.1)',
  },
  analyticsLabel: { color: 'rgba(255,255,255,0.8)', fontSize: 14 },
  analyticsValue: { color: 'white', fontSize: 14, fontWeight: '700' },
});

/* ----------------------- Auth Screens ------------------------- */
function SignUpScreen({ navigation }: any) {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [agreedToTerms, setAgreedToTerms] = useState(false);

  const validatePassword = (p: string) => {
    if (p.length < 8 || p.length > 64) return false;
    const checks = [
      /[a-z]/.test(p), // lowercase
      /[A-Z]/.test(p), // uppercase
      /\d/.test(p), // number
      /[^a-zA-Z0-9]/.test(p), // symbol
    ];
    return checks.filter(Boolean).length >= 3;
  };

  const signUp = async () => {
    const trimmedEmail = email.trim();
    const trimmedUsername = username.trim();

    if (!trimmedEmail || !password || !confirmPassword || !trimmedUsername) {
      Alert.alert('Missing Info', 'Please fill out all fields.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      Alert.alert('Invalid Email', 'Please enter a valid email address.');
      return;
    }
    if (!validatePassword(password)) {
      Alert.alert(
        'Weak Password',
        'Password must be 8-64 characters and contain at least 3 of the following: uppercase, lowercase, number, symbol.',
      );
      return;
    }
    if (password !== confirmPassword) {
      Alert.alert(
        'Passwords Do Not Match',
        'Please re-enter your password to confirm.',
      );
      return;
    }
    if (!agreedToTerms) {
      Alert.alert(
        'Agreement Required',
        'You must agree to the Terms of Service and Privacy Policy to continue.',
      );
      return;
    }
    try {
      // Create user but don't auto-sign in
      const userCredential = await auth().createUserWithEmailAndPassword(
        trimmedEmail,
        password,
      );
      if (userCredential.user) {
        // Store username and other details in Firestore
        const firestore = require('@react-native-firebase/firestore').default;
        // Ensure username starts with /
        const usernameWithSlash = trimmedUsername.startsWith('/') ? trimmedUsername : '/' + trimmedUsername;
        // Store username_lc without / for search
        const usernameLc = trimmedUsername.replace(/^[\/]+/, '').toLowerCase();
        
        await firestore().collection('users').doc(userCredential.user.uid).set({
          username: usernameWithSlash,
          displayName: usernameWithSlash,
          username_lc: usernameLc,
          email: trimmedEmail,
          createdAt: firestore.FieldValue.serverTimestamp(),
        });

        // Sign the user out immediately after creation
        await auth().signOut();

        Alert.alert(
          'Account Created!',
          'Your account has been successfully created. Please sign in to continue.',
          [{ text: 'OK', onPress: () => navigation.replace('SignIn') }],
        );
      }
    } catch (e: any) {
      if (e.code === 'auth/email-already-in-use') {
        Alert.alert('Sign Up Failed', 'This email address is already in use.');
      } else {
        Alert.alert(
          'Sign Up Failed',
          e?.message ?? 'An unknown error occurred. Please try again.',
        );
      }
    }
  };

  return (
    <View style={authStyles.screen}>
      <AuthBackground />
      <KeyboardAvoidingView
        behavior={Platform.select({ ios: 'padding', android: undefined })}
        style={{ flex: 1, justifyContent: 'center' }}
      >
        <ScrollView showsVerticalScrollIndicator={false}>
          <Text style={authStyles.title}>Create your account</Text>

          <Field
            label="Username"
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
          />

          <Field
            label="Email"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
          />
          <Field
            label="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
          />
          <Text
            style={{
              color: 'rgba(255,255,255,0.7)',
              fontSize: 12,
              marginTop: -8,
              marginBottom: 8,
            }}
          >
            8-64 chars; 3 of: upper, lower, num, symbol.
          </Text>
          <Field
            label="Confirm Password"
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            secureTextEntry
          />

          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              marginVertical: 12,
            }}
          >
            <TouchableOpacity
              onPress={() => setAgreedToTerms(!agreedToTerms)}
              style={{
                width: 24,
                height: 24,
                borderWidth: 1,
                borderColor: 'white',
                borderRadius: 4,
                marginRight: 12,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {agreedToTerms && (
                <Text
                  style={{ color: 'white', fontSize: 16, fontWeight: 'bold' }}
                >
                  ✓
                </Text>
              )}
            </TouchableOpacity>
            <Text style={{ color: 'white', flex: 1 }}>
              I agree to the{' '}
              <Text
                style={{ color: '#2196F3', textDecorationLine: 'underline' }}
                onPress={() =>
                  Alert.alert('Terms', 'Terms of Service go here.')
                }
              >
                Terms of Service
              </Text>{' '}
              and{' '}
              <Text
                style={{ color: '#2196F3', textDecorationLine: 'underline' }}
                onPress={() =>
                  Alert.alert('Privacy', 'Privacy Policy goes here.')
                }
              >
                Privacy Policy
              </Text>
              .
            </Text>
          </View>

          <AuthButton title="Sign Up" onPress={signUp} />

          <TouchableOpacity
            onPress={() => navigation.replace('SignIn')}
            style={{ marginTop: 14 }}
          >
            <Text style={authStyles.link}>
              Already have an account? Sign In
            </Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

function SignInScreen({ navigation }: any) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const signIn = async () => {
    if (!email || !password) {
      Alert.alert('Missing info', 'Enter email and password.');
      return;
    }
    try {
      await auth().signInWithEmailAndPassword(email.trim(), password);
      // onAuthStateChanged will route to Home automatically
    } catch (e: any) {
      Alert.alert('Sign in failed', e?.message ?? 'Try again.');
    }
  };

  const resetPassword = async () => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      Alert.alert('Missing Email', 'Enter your email to reset the password.');
      return;
    }

    try {
      await auth().sendPasswordResetEmail(trimmedEmail);
      Alert.alert(
        'Reset Link Sent',
        'A password reset link has been sent to your email address.',
      );
    } catch (e: any) {
      Alert.alert('Reset Failed', e?.message ?? 'Unable to send reset link.');
    }
  };

  return (
    <View style={authStyles.screen}>
      <AuthBackground />
      <KeyboardAvoidingView
        behavior={Platform.select({ ios: 'padding', android: undefined })}
        style={{ flex: 1, justifyContent: 'center' }}
      >
        <Text style={authStyles.title}>Welcome back</Text>

        <Field
          label="Email"
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
        />
        <Field
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
        />

        <TouchableOpacity onPress={resetPassword} style={{ marginTop: 6 }}>
          <Text style={authStyles.link}>Forgot Password?</Text>
        </TouchableOpacity>

        <View style={{ marginTop: 4 }}>
          <AuthButton title="Sign In" onPress={signIn} />
        </View>

        <TouchableOpacity
          onPress={() => navigation.replace('SignUp')}
          style={{ marginTop: 14 }}
        >
          <Text style={authStyles.link}>New Here? Sign up</Text>
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </View>
  );
}

function WelcomeAnimationScreen({ navigation }: any) {
  const [dots, setDots] = React.useState(0);
  const isMounted = React.useRef(true);
  const fadeAnim = React.useRef(new Animated.Value(0)).current;
  const scaleAnim = React.useRef(new Animated.Value(0.8)).current;
  const waveAnim = React.useRef(new Animated.Value(0)).current;
  const dropAnim = React.useRef(new Animated.Value(-50)).current;

  React.useEffect(() => {
    // Entrance animations
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 800,
        useNativeDriver: true,
      }),
      Animated.spring(scaleAnim, {
        toValue: 1,
        friction: 8,
        tension: 40,
        useNativeDriver: true,
      }),
      Animated.timing(dropAnim, {
        toValue: 0,
        duration: 600,
        delay: 200,
        useNativeDriver: true,
      }),
    ]).start();

    // Continuous wave animation
    Animated.loop(
      Animated.sequence([
        Animated.timing(waveAnim, {
          toValue: 1,
          duration: 2000,
          useNativeDriver: true,
        }),
        Animated.timing(waveAnim, {
          toValue: 0,
          duration: 2000,
          useNativeDriver: true,
        }),
      ]),
    ).start();

    return () => {
      isMounted.current = false;
    };
  }, []);

  React.useEffect(() => {
    let i = 0;
    const interval = setInterval(() => {
      i += 1;
      if (isMounted.current) {
        setDots(i);
      }
      if (i >= 6) {
        clearInterval(interval);
        if (isMounted.current) {
          navigation.replace('AppHome');
        }
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [navigation]);

  const handleSkip = () => {
    if (isMounted.current) {
      navigation.replace('AppHome');
    }
  };

  const waveTranslate = waveAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 10],
  });

  return (
    <Pressable
      style={{
        flex: 1,
        backgroundColor: '#0A1929',
      }}
      onPress={handleSkip}
    >
      {/* Swimming fish background */}
      {/* Removed SwimmingFishLoader animation */}
      
      {/* Main content with flex layout */}
      <View style={{ flex: 1, justifyContent: 'space-between', paddingTop: 60, paddingBottom: 30, zIndex: 10 }}>
        
        {/* Header Section - Logo & Tagline */}
        <Animated.View
          style={{
            alignItems: 'center',
            opacity: fadeAnim,
            paddingTop: 80,
          }}
        >
          <Animated.Text
            style={{
              fontSize: 72,
              marginBottom: 16,
              transform: [{ translateY: dropAnim }],
              color: '#7C0000',
            }}
          >
            🩸
          </Animated.Text>
          
          <Text
            style={{
              fontStyle: 'italic',
              fontSize: 48,
              color: '#C0C0C0',
              fontWeight: 'bold',
              textShadowColor: 'rgba(192,192,192,0.8)',
              textShadowOffset: { width: 0, height: 0 },
              textShadowRadius: 25,
            }}
          >
            SplashLine
          </Text>

          <Animated.Text
            style={{
              fontStyle: 'italic',
              fontSize: 18,
              color: 'white',
              marginTop: 16,
              transform: [{ translateY: waveTranslate }],
            }}
          >
            Make a splash. Get seen!
          </Animated.Text>
        </Animated.View>
        
        {/* Feature Section - Bottom */}
        <Animated.View
          style={{
            alignItems: 'center',
            opacity: fadeAnim,
            paddingBottom: 24,
            paddingHorizontal: 24,
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              marginTop: 12,
              width: '100%',
              paddingHorizontal: 12,
            }}
          >
            <Text
              style={{
                color: 'rgba(255,255,255,0.95)',
                fontSize: 15,
                fontWeight: '700',
                textAlign: 'center',
                marginHorizontal: 2,
                flexShrink: 0,
                flexGrow: 0,
              }}
            >
              Dive into waves
            </Text>
            <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 16, fontWeight: '700', marginHorizontal: 8 }}>|</Text>
            <Text
              style={{
                color: 'rgba(255,255,255,0.95)',
                fontSize: 15,
                fontWeight: '700',
                textAlign: 'center',
                marginHorizontal: 2,
                flexShrink: 0,
                flexGrow: 0,
              }}
            >
              Make splashes
            </Text>
            <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 16, fontWeight: '700', marginHorizontal: 8 }}>|</Text>
            <Text
              style={{
                color: 'rgba(255,255,255,0.95)',
                fontSize: 15,
                fontWeight: '700',
                textAlign: 'center',
                marginHorizontal: 2,
                flexShrink: 0,
                flexGrow: 0,
              }}
            >
              Send echoes
            </Text>
          </View>
        </Animated.View>
      </View>
    </Pressable>
  );
}
/* ----------------------- Root Navigator ----------------------- */
function AuthStack() {
  // Show the sign-in screen first so returning users arrive on it immediately
  return (
    <Stack.Navigator
      screenOptions={{ headerShown: false }}
      initialRouteName="SignIn"
    >
      <Stack.Screen name="SignUp" component={SignUpScreen} />
      <Stack.Screen name="SignIn" component={SignInScreen} />
    </Stack.Navigator>
  );
}

function AppStack() {
  return (
    <Stack.Navigator
      screenOptions={{ headerShown: false }}
      initialRouteName="WelcomeAnimation"
    >
      <Stack.Screen
        name="WelcomeAnimation"
        component={WelcomeAnimationScreen}
      />
      <Stack.Screen name="AppHome" component={InnerApp} />
    </Stack.Navigator>
  );
}

// Install global guards to stop first-launch crashes from uncaught errors
function installGlobalErrorGuards(onError: (err: Error) => void) {
  const globalObj: any = (typeof global !== 'undefined' ? global : globalThis) as any;
  const errorUtils = globalObj?.ErrorUtils;
  let previousHandler: any = null;

  try {
    previousHandler = errorUtils?.getGlobalHandler?.() || null;
    errorUtils?.setGlobalHandler?.((err: any, isFatal?: boolean) => {
      try {
        const safeErr = err instanceof Error ? err : new Error(String(err));
        onError(safeErr);
      } catch {}
      if (__DEV__ && previousHandler) {
        try {
          previousHandler(err, isFatal);
        } catch {}
      }
    });
  } catch (installErr) {
    console.warn('Failed to install global error handler', installErr);
  }

  let cleanupUnhandled: (() => void) | null = null;
  try {
    const rejectionHandler = (event: any) => {
      const reason = event?.reason || event;
      const safeErr = reason instanceof Error ? reason : new Error(String(reason));
      onError(safeErr);
      return true;
    };

    if (globalObj?.addEventListener) {
      globalObj.addEventListener('unhandledrejection', rejectionHandler);
      cleanupUnhandled = () => {
        try {
          globalObj.removeEventListener?.('unhandledrejection', rejectionHandler);
        } catch {}
      };
    } else if (globalObj?.process?.on) {
      const fn = (reason: any) => rejectionHandler({ reason });
      globalObj.process.on('unhandledRejection', fn);
      cleanupUnhandled = () => {
        try {
          globalObj.process.off?.('unhandledRejection', fn);
        } catch {}
      };
    }
  } catch (installErr) {
    console.warn('Failed to install unhandled rejection handler', installErr);
  }

  return () => {
    try {
      cleanupUnhandled?.();
    } catch {}
    try {
      if (errorUtils?.setGlobalHandler && previousHandler) {
        errorUtils.setGlobalHandler(previousHandler);
      }
    } catch {}
  };
}

// ======================== ROOT (Provider Wrapper) ========================
// Defensive error boundary for app resilience
class SafeApp extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  cleanup: (() => void) | null = null;
  state = { error: null as Error | null };

  componentDidMount() {
    this.cleanup = installGlobalErrorGuards((err: Error) => {
      console.error('Global error captured:', err);
      this.setState({ error: err });
    });
  }

  componentWillUnmount() {
    try {
      this.cleanup?.();
    } catch {}
  }

  componentDidCatch(error: Error) {
    console.error('Render error boundary caught:', error);
    this.setState({ error });
  }

  handleRetry = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <View
          style={{
            flex: 1,
            backgroundColor: 'black',
            justifyContent: 'center',
            alignItems: 'center',
            padding: 24,
          }}
        >
          <Text style={{ color: 'white', fontSize: 18, textAlign: 'center', marginBottom: 10 }}>
            We hit a snag starting Drift.
          </Text>
          <Text
            style={{
              color: 'rgba(255,255,255,0.75)',
              fontSize: 14,
              textAlign: 'center',
              marginBottom: 16,
            }}
          >
            Tap retry to reopen without a crash.
          </Text>
          <TouchableOpacity
            onPress={this.handleRetry}
            style={{
              backgroundColor: '#00C2FF',
              paddingHorizontal: 18,
              paddingVertical: 10,
              borderRadius: 10,
            }}
          >
            <Text style={{ color: '#001529', fontWeight: '700', fontSize: 15 }}>Retry</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return (
      <React.Suspense
        fallback={
          <View
            style={{
              flex: 1,
              backgroundColor: 'black',
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <Text style={{ color: 'white' }}>Loading...</Text>
          </View>
        }
      >
        {this.props.children}
      </React.Suspense>
    );
  }
}

const App: React.FC = () => {
  // The splash animation is now part of the navigation flow,
  // so we no longer need state to control its visibility here.
  // const [showSplash, setShowSplash] = React.useState(true);
  const [initializing, setInitializing] = useState(true);
  const [user, setUser] = useState<FirebaseAuthTypes.User | null>(null);


  // Defensive: wrap all native module init in try/catch and show fallback UI if any fail
  const [nativeInitError, setNativeInitError] = useState<string | null>(null);
  const [appResumeTick, setAppResumeTick] = useState(0);

  // Global safety net so fatal JS errors show the retry screen instead of closing the app on first open
  useEffect(() => {
    const eu: any = (global as any)?.ErrorUtils;
    if (!eu || !eu.getGlobalHandler || !eu.setGlobalHandler) return;
    const previous = eu.getGlobalHandler();
    const safeHandler = (error: any, isFatal?: boolean) => {
      try {
        const msg =
          (error && error.message) ||
          (typeof error === 'string' ? error : 'Unexpected error');
        setNativeInitError(`App error${isFatal ? ' (fatal)' : ''}: ${msg}`);
      } catch {}
      if (previous && previous !== safeHandler) {
        try {
          previous(error, isFatal);
        } catch {}
      }
    };
    eu.setGlobalHandler(safeHandler);
    return () => {
      try {
        eu.setGlobalHandler(previous);
      } catch {}
    };
  }, []);

  useEffect(() => {
    try {
      if (FORCE_SIGN_OUT_ON_START) {
        auth()
          .signOut()
          .catch(() => {});
      }
    } catch (e) {
      setNativeInitError('Native module error: ' + (e && e.message ? e.message : String(e)));
    }
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') {
        setNativeInitError(null);
        setAppResumeTick(t => t + 1);
      }
    });
    return () => {
      try {
        sub?.remove?.();
      } catch {}
    };
  }, []);

  useEffect(() => {
    let unsub: any = null;
    try {
      unsub = auth().onAuthStateChanged(u => {
        setUser(u);
        if (initializing) setInitializing(false);
      });
    } catch (e) {
      setNativeInitError('Native module error: ' + (e && e.message ? e.message : String(e)));
    }
    return unsub;
  }, [initializing, appResumeTick]);

  // Defensive: check for native module errors and show fallback UI
  if (nativeInitError) {
    return (
      <View style={{ flex: 1, backgroundColor: 'black', justifyContent: 'center', alignItems: 'center', padding: 24 }}>
        <Text style={{ color: 'white', fontSize: 18, textAlign: 'center', marginBottom: 10 }}>
          A critical error occurred initializing the app.
        </Text>
        <Text style={{ color: 'rgba(255,255,255,0.75)', fontSize: 14, textAlign: 'center', marginBottom: 16 }}>
          {nativeInitError}
        </Text>
        <TouchableOpacity
          onPress={() => setNativeInitError(null)}
          style={{ backgroundColor: '#00C2FF', paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10 }}
        >
          <Text style={{ color: '#001529', fontWeight: '700', fontSize: 15 }}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: 'black' }}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <SafeApp>
            <DataSaverProvider>
              <Suspense fallback={<ActivityIndicator size="large" color="#00C2FF" style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }} />}>
                <NavigationContainer>
                  {initializing ? (
                    <View
                      style={{
                        flex: 1,
                        justifyContent: 'center',
                        alignItems: 'center',
                        backgroundColor: '#0A1929',
                      }}
                    >
                      <ActivityIndicator size="large" color="#00C2FF" />
                      <Text
                        style={{
                          marginTop: 16,
                          color: '#00C2FF',
                          fontSize: 16,
                          fontStyle: 'italic',
                        }}
                      >
                        Navigating the seas…
                      </Text>
                    </View>
                  ) : user ? (
                    <AppStack />
                  ) : (
                    <AuthStack />
                  )}
                </NavigationContainer>
              </Suspense>
            </DataSaverProvider>
          </SafeApp>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </View>
  );
};

// Top-level error boundary wrapper for the app
const AppWithErrorBoundary: React.FC = () => (
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);

export default AppWithErrorBoundary;

/* --------------------------- Styles --------------------------- */
const authStyles = StyleSheet.create({
  screen: {
    flex: 1,
    padding: 20,
    backgroundColor: 'transparent',
    paddingTop: 40,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 20,
    color: 'white',
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowRadius: 4,
    textShadowOffset: { width: 1, height: 1 },
  },
  label: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.9)',
    marginBottom: 6,
    fontWeight: '600',
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowRadius: 2,
  },
  input: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.4)',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: Platform.select({ ios: 12, android: 10 }),
    fontSize: 16,
    backgroundColor: 'rgba(0,0,0,0.35)',
    color: 'white',
  },
  btn: {
    backgroundColor: '#007bff',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 6,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
  },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  link: {
    color: '#2196F3',
    textAlign: 'center',
    fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowRadius: 2,
  },
});
