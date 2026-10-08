/*
 * Where accounts and scores are stored.
 *
 * Leave both values empty to keep everything in this browser only. To share
 * one leaderboard between all players, create a Supabase project, run
 * supabase/schema.sql in its SQL editor, and paste the project URL and its
 * public (anon / publishable) key here. That key is meant to be public: the
 * database only lets it call the four functions in schema.sql.
 */
window.FIND_AIRCRAFT_CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: '',
};
