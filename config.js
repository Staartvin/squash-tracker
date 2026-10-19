// Settings for the squash tracker. This is the only file you need to edit.
//
// Leave supabaseUrl empty to run in demo mode with sample data (stored only in
// your own browser). Fill in both Supabase values to use the shared database.
window.SQUASH_CONFIG = {
  title: 'Squash Crew',

  // Supabase -> Project Settings -> API (or "Connect"). The publishable/anon key
  // is meant to be public; the group code in schema.sql protects writes.
  supabaseUrl: 'https://ttnnwvvadqdqteboicww.supabase.co',
  supabaseKey: 'sb_publishable_8rrbT4hVkZCZC4y5UyKlhQ_MTUJIgQm',

  // First day of the subscription year. Each season runs one year from here.
  seasonStart: '2026-10-03',

  // What the yearly "Daluren" subscription costs per person.
  subscriptionPrice: 315,

  // What one visit would cost each person without a subscription.
  // Friday off-peak isn't open to non-subscribers, so this is a judgement
  // call: 10 counts it like any off-peak visit.
  slotValues: {
    offpeak: 10,
    fri_peak: 14,
    fri_offpeak: 10,
  },
};
