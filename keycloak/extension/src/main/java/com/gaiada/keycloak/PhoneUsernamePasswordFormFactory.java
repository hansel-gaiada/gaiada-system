package com.gaiada.keycloak;

import org.keycloak.authentication.Authenticator;
import org.keycloak.authentication.authenticators.browser.UsernamePasswordFormFactory;
import org.keycloak.models.KeycloakSession;

/**
 * Registers {@link PhoneUsernamePasswordForm}. It extends the stock factory so the reference category ("pwd" in the
 * amr claim), the requirement choices and the passkey options stay Keycloak's own at every upgrade.
 *
 * <p>keycloak-passkey-realm.sh puts this provider in the forms of the gaiada-passkey-browser flow. The revert is the
 * same script with LOGIN_FORM=auth-username-password-form: the stock form again, username and email sign-in unchanged.
 */
public class PhoneUsernamePasswordFormFactory extends UsernamePasswordFormFactory {

    public static final String PROVIDER_ID = "gaiada-phone-username-password-form";

    @Override
    public Authenticator create(KeycloakSession session) {
        return new PhoneUsernamePasswordForm(session);
    }

    @Override
    public String getId() {
        return PROVIDER_ID;
    }

    @Override
    public String getDisplayType() {
        return "Username, Email or Phone Password Form";
    }

    @Override
    public String getHelpText() {
        return "The Username Password Form, which also finds the person by the phone number in their profile "
                + "(08..., 62... or +62...). Refuses a number that two accounts share.";
    }
}
