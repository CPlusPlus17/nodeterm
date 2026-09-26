import { REPO_URL } from './bugReport'

/** nodeterm mobile on the App Store (live since 1.0). One home for the link so the welcome
 *  flow, Settings → Phone and the quick-pair popover can never drift apart. */
export const IOS_APP_STORE_URL = 'https://apps.apple.com/app/nodeterm/id6790581233'

/** nodeterm for Android: SOURCE, not an installable. There is no store listing and no published
 *  APK yet (the only APK is an expiring CI run artifact behind a GitHub login), so the link opens
 *  the repo's `android/` folder, whose README says how to build it. Both call sites label it
 *  "(build from source)" for that reason — it sits beside an App Store link, and without the label
 *  it reads as a download. Once a signed release APK is published, point this at that release
 *  asset and drop the label.
 *
 *  Derived from `REPO_URL` rather than spelled out, so the repository has one home. */
export const ANDROID_APP_URL = `${REPO_URL}/tree/main/android`

/** The visible label of that link, shared by Settings → Phone and the quick-pair popover so the
 *  two can never disagree about what it opens. */
export const ANDROID_APP_LABEL = 'nodeterm for Android (build from source)'
