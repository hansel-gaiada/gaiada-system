package com.gaiada.keycloak;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.util.List;
import java.util.function.Function;

import org.junit.jupiter.api.Test;

import com.gaiada.keycloak.AccountMatch.Outcome;

class AccountMatchTest {

    /** An account in these tests: just its id. */
    private static final Function<String, String> ID = Function.identity();

    @Test
    void oneHolderOfTheNumberIsTheAccount() {
        AccountMatch<String> m = AccountMatch.of(null, List.of("alice"), ID);
        assertEquals("alice", m.account());
        assertEquals(Outcome.PHONE, m.outcome());
    }

    @Test
    void theSameAccountByNameAndByNumberIsStillThatAccount() {
        AccountMatch<String> m = AccountMatch.of("alice", List.of("alice"), ID);
        assertEquals("alice", m.account());
        assertEquals(Outcome.PHONE, m.outcome());
    }

    @Test
    void aSharedNumberNamesNobody() {
        AccountMatch<String> m = AccountMatch.of(null, List.of("bob", "ivan"), ID);
        assertNull(m.account());
        assertEquals(Outcome.SHARED_NUMBER, m.outcome());
    }

    @Test
    void aSharedNumberNamesNobodyEvenWhenOneHolderHasItAsUsername() {
        AccountMatch<String> m = AccountMatch.of("bob", List.of("bob", "ivan"), ID);
        assertNull(m.account());
        assertEquals(Outcome.SHARED_NUMBER, m.outcome());
    }

    @Test
    void oneAccountsNumberAndAnotherAccountsUsernameNamesNobody() {
        AccountMatch<String> m = AccountMatch.of("digits-user", List.of("alice"), ID);
        assertNull(m.account());
        assertEquals(Outcome.NAME_AND_PHONE_DIFFER, m.outcome());
    }

    @Test
    void noHolderFallsBackToTheUsername() {
        AccountMatch<String> m = AccountMatch.of("digits-user", List.of(), ID);
        assertEquals("digits-user", m.account());
        assertEquals(Outcome.NAME, m.outcome());
    }

    @Test
    void nobodyAtAll() {
        AccountMatch<String> m = AccountMatch.of(null, List.of(), ID);
        assertNull(m.account());
        assertEquals(Outcome.NONE, m.outcome());
    }

    @Test
    void twoLookupsOfOneAccountAreComparedById() {
        record Account(String id, String loadedBy) {
        }
        Account byName = new Account("u-1", "name");
        Account byPhone = new Account("u-1", "phone");
        AccountMatch<Account> m = AccountMatch.of(byName, List.of(byPhone), Account::id);
        assertEquals(byPhone, m.account());
        assertEquals(Outcome.PHONE, m.outcome());
    }
}
