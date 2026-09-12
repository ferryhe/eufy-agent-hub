# Shared components

`results.mjs` provides plain DOM device cards, ordered recording timelines, registered players and job cards. Both fixed browsing and the Agent view use the same main result area. Legacy event queries use the same timeline and player functions; their download action stays on the established event API.

The components display API data. They do not resolve devices, normalize dates, infer online state or decide completeness. Continuous job views come from the root Agent HTTP client's authoritative description: playable partial footage remains partial. The timeline shows the service's normalized UTC boundaries and effective timezone beside the original local request; index availability is not completeness evidence. Device execution eligibility and verification evidence are separate.

Registered artifact URLs are used verbatim. Video elements are keyed by job/artifact identity, so routine status polls, view switches and language changes preserve playback. The shared [i18n catalogs](../i18n/README.md) supply labels, retaining raw device names and diagnostic details. DOM behavior is tested with linkedom and actual browser validation covers media/layout.
