package com.gaiada.keycloak;

import java.util.List;
import java.util.Locale;

import jakarta.ws.rs.core.MultivaluedMap;

import org.jboss.logging.Logger;
import org.keycloak.authentication.AuthenticationFlowContext;
import org.keycloak.authentication.authenticators.browser.UsernamePasswordForm;
import org.keycloak.authentication.authenticators.util.AuthenticatorUtils;
import org.keycloak.events.Details;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.ModelDuplicateException;
import org.keycloak.models.UserModel;
import org.keycloak.models.utils.KeycloakModelUtils;
import org.keycloak.services.managers.AuthenticationManager;

/**
 * Keycloak's Username Password Form that also finds the person by phone number (PID-D9, plan §5.3).
 *
 * <p>A username or an email goes to the stock form unchanged. A phone number (08…, 62…, +62…, with or without spaces
 * or dashes) is looked up in the {@value #PHONE_ATTRIBUTE} attribute, and then the stock checks run in the stock order:
 * the password, brute-force detection, the account enabled, remember-me. Every refusal gives the stock "invalid
 * username or password", after the same dummy password hash the stock form spends on an unknown name.
 */
public class PhoneUsernamePasswordForm extends UsernamePasswordForm {

    private static final Logger LOG = Logger.getLogger(PhoneUsernamePasswordForm.class);

    /** The user-profile attribute that infra/scripts/keycloak-passkey-realm.sh adds (PID-2a). */
    static final String PHONE_ATTRIBUTE = "phoneNumber";
    /** Event detail: how the person named themselves at sign-in. */
    static final String DETAIL_IDENTIFIER = "login_identifier";

    public PhoneUsernamePasswordForm(KeycloakSession session) {
        super(session);
    }

    @Override
    protected boolean validateForm(AuthenticationFlowContext context, MultivaluedMap<String, String> formData) {
        String typed = formData.getFirst(AuthenticationManager.FORM_USERNAME);
        String phone = PhoneNumbers.toStored(typed);
        if (phone == null || isUserAlreadySetBeforeUsernamePasswordAuth(context)) {
            return super.validateForm(context, formData);
        }
        // AbstractUsernameFormAuthenticator#validateUserAndPassword, step for step, with the person found by number.
        context.clearUser();
        String trimmed = typed.trim();
        AccountMatch<UserModel> match = find(context, trimmed, phone);
        UserModel user = match.account();
        // Keycloak's brute-force check finds the person again from this note, by username or email
        // (AuthenticationManager#lookupUserForBruteForceLog). A phone number here would let anyone guess passwords by
        // phone with no lockout, so once the number names one account the note holds that account's username.
        String attempted = user != null ? user.getUsername() : trimmed;
        context.getEvent().detail(Details.USERNAME, attempted).detail(DETAIL_IDENTIFIER, "phone");
        context.getAuthenticationSession().setAuthNote(ATTEMPTED_USERNAME, attempted);
        if (user == null && match.outcome() != AccountMatch.Outcome.NONE) {
            context.getEvent().detail(Details.REASON, match.outcome().name().toLowerCase(Locale.ROOT));
            LOG.warnf("phone sign-in refused in realm %s: %s", context.getRealm().getName(), match.outcome());
        }
        testInvalidUser(context, user);
        if (user == null) {
            return false;
        }
        if (!validatePassword(context, user, formData, true)) {
            return false;
        }
        if (!enabledUser(context, user)) {
            return false;
        }
        AuthenticatorUtils.processRememberMe(context, formData);
        context.setUser(user);
        return true;
    }

    private static AccountMatch<UserModel> find(AuthenticationFlowContext context, String typed, String phone) {
        UserModel byName;
        try {
            byName = KeycloakModelUtils.findUserByNameOrEmail(context.getSession(), context.getRealm(), typed);
        } catch (ModelDuplicateException e) {
            return AccountMatch.refused(AccountMatch.Outcome.NAME_NOT_UNIQUE);
        }
        List<UserModel> byPhone = context.getSession().users()
                .searchForUserByUserAttributeStream(context.getRealm(), PHONE_ATTRIBUTE, phone)
                .limit(2)
                .toList();
        return AccountMatch.of(byName, byPhone, UserModel::getId);
    }
}
