// Fork: unit tests render dialogs and menus, which read the i18n config.
import { initializeGT } from "gt-react";

import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "../src/i18n/locales";

await initializeGT({ defaultLocale: DEFAULT_LOCALE, locales: [...SUPPORTED_LOCALES] });
