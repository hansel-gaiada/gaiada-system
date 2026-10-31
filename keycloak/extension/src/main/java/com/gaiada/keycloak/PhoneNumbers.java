package com.gaiada.keycloak;

import java.util.regex.Pattern;

/**
 * Turns what a person types as a phone number into the form the realm stores it in: E.164, "+62…" (plan §5.2; the user
 * profile accepts only that form, so 08… is converted here, on the way in). Anything that is not a phone number gives
 * null, and the sign-in falls back to Keycloak's own username-or-email lookup.
 */
public final class PhoneNumbers {

    /** E.164: a plus, a country code that does not start with 0, 8 to 15 digits in all. */
    static final Pattern E164 = Pattern.compile("\\+[1-9][0-9]{7,14}");
    /** What people put between the digits: spaces, dots, dashes and brackets. */
    private static final Pattern SEPARATORS = Pattern.compile("[\\s.()\\-]");
    /** Longer than any phone number with separators; keeps the regex work bounded. */
    static final int MAX_TYPED = 32;

    private PhoneNumbers() {
    }

    /** The stored form of a typed phone number, or null when the text is not a phone number. */
    public static String toStored(String typed) {
        if (typed == null || typed.length() > MAX_TYPED) {
            return null;
        }
        String s = SEPARATORS.matcher(typed.trim()).replaceAll("");
        if (s.startsWith("00")) {
            s = "+" + s.substring(2); // the international call prefix
        } else if (s.startsWith("62")) {
            s = "+" + s; // 62812… written without the plus
        } else if (s.startsWith("0")) {
            s = "+62" + s.substring(1); // 0812…: an Indonesian number with its trunk 0
        } else if (!s.startsWith("+")) {
            return null;
        }
        if (s.startsWith("+620")) {
            s = "+62" + s.substring(4); // +62 0812…: the trunk 0 does not belong after the country code
        }
        return E164.matcher(s).matches() ? s : null;
    }
}
