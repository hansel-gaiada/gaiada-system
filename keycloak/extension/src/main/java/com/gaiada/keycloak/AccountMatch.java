package com.gaiada.keycloak;

import java.util.List;
import java.util.function.Function;

/**
 * The account a phone-shaped sign-in names, decided without Keycloak so it can be tested on its own.
 *
 * <p>It fails closed (plan §6 risk 11). A number two accounts hold, or a text that is one account's phone number and
 * another account's username, names nobody. The person then gets the same "invalid username or password" as for a
 * name that does not exist, so the answer says nothing about which numbers are in use.
 *
 * @param account the account, or null when the text names none (or more than one)
 * @param outcome how it was decided; the refusals are logged and put on the LOGIN_ERROR event for IT
 */
public record AccountMatch<U>(U account, Outcome outcome) {

    public enum Outcome {
        /** exactly one account holds the number (and no other account has it as its username) */
        PHONE,
        /** no account holds the number, one account has the text as its username */
        NAME,
        /** nobody */
        NONE,
        /** two or more accounts hold the number: refused */
        SHARED_NUMBER,
        /** one account holds the number and a different account has the text as its username: refused */
        NAME_AND_PHONE_DIFFER,
        /** the username or email lookup itself found duplicates (only possible with user federation): refused */
        NAME_NOT_UNIQUE
    }

    public static <U> AccountMatch<U> refused(Outcome outcome) {
        return new AccountMatch<>(null, outcome);
    }

    /**
     * @param byName  the account whose username or email is exactly the typed text, or null
     * @param byPhone the accounts whose stored phone number is the typed number; the caller may stop counting at two
     * @param id      an account's stable id, to tell one account found twice from two accounts
     */
    public static <U> AccountMatch<U> of(U byName, List<U> byPhone, Function<U, String> id) {
        if (byPhone.size() > 1) {
            return refused(Outcome.SHARED_NUMBER);
        }
        if (byPhone.size() == 1) {
            U holder = byPhone.get(0);
            if (byName != null && !id.apply(byName).equals(id.apply(holder))) {
                return refused(Outcome.NAME_AND_PHONE_DIFFER);
            }
            return new AccountMatch<>(holder, Outcome.PHONE);
        }
        return byName != null ? new AccountMatch<>(byName, Outcome.NAME) : refused(Outcome.NONE);
    }
}
