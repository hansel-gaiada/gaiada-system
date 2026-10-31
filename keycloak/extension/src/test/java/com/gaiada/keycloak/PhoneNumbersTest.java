package com.gaiada.keycloak;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.NullAndEmptySource;
import org.junit.jupiter.params.provider.ValueSource;

class PhoneNumbersTest {

    @ParameterizedTest(name = "\"{0}\" -> {1}")
    @CsvSource(delimiter = '|', value = {
        "081234567001        | +6281234567001",
        "0812-3456-7001      | +6281234567001",
        "0812 3456 7001      | +6281234567001",
        "(0812) 3456.7001    | +6281234567001",
        "6281234567001       | +6281234567001",
        "62 812 3456 7001    | +6281234567001",
        "+6281234567001      | +6281234567001",
        "+62 812-3456-7001   | +6281234567001",
        "+62 0812 3456 7001  | +6281234567001",
        "006281234567001     | +6281234567001",
        "'  081234567001  '  | +6281234567001",
        "0361123456          | +62361123456",
        "+14155550123        | +14155550123",
        "+447700900123       | +447700900123",
    })
    void storesThePhoneNumbersPeopleType(String typed, String stored) {
        assertEquals(stored, PhoneNumbers.toStored(typed));
    }

    @ParameterizedTest(name = "\"{0}\" is not a phone number")
    @NullAndEmptySource
    @ValueSource(strings = {
        "pid.alice",
        "pid.alice@example.invalid",
        "alice0812",
        "812345670",          // no trunk 0, no country code: a username, not a number
        "0812",               // too short to be a number
        "+0812345678",        // a country code never starts with 0
        "+1234567890123456",  // longer than E.164 allows
        "0812345abc",
        "+62+81234567001",
        "08123456700१",       // a non-ASCII digit
        "0812 3456 7001 0812 3456 7001 0812",  // longer than anyone types a number
    })
    void leavesEverythingElseToTheUsernameLookup(String typed) {
        assertNull(PhoneNumbers.toStored(typed));
    }
}
