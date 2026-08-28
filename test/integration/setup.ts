// Load sandbox integration credentials before any test runs. These live in
// .env.testing (gitignored), separate from .env, so the suite never touches
// production accounts. Missing .env.testing is fine — tests self-skip when their
// credentials are absent.
import { config } from 'dotenv';

config({ path: '.env.testing' });
