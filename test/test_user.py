import json
import pytest


class TestUser:
    def test_can_create_new_user(self, helper):
        print("If a new user Bob signs up", end="")
        bob = helper.given_new_user(self, "bob")

        print(
            "Then Bob should able to log in with his username in 'username' API field"
        )
        helper.login_as(bob.username)

        print(
            "And Bob should able to log in with his username in 'emailOrUsername' API field"
        )
        helper.login_with_name_or_email(bob.username, bob.username)

        print("And Bob should able to log in with his email in 'email' API field")
        helper.login_with_email(bob.username, bob.email)

        print(
            "And Bob should able to log in with his email in 'emailOrUsername' API field"
        )
        helper.login_with_name_or_email(bob.username, bob.email)

        print("And Bob should be able to see his details include user id. ")
        helper.admin_user().get_user_details(helper.admin_user())
        bob.get_user_details(bob)
        bobUserDetails = bob.get_user_details(helper.admin_user())

        print("Bob's user id is {}".format(bobUserDetails))

    def test_create_duplicate_user(self, helper):
        # Ensure the user exists
        try:
            print("If a user DuplicateBob signs up")
            helper.given_new_fixed_user("DuplicateBob")
        except OSError:
            pass  # expected

        # Now try to create the same user again
        with pytest.raises(OSError) as excinfo:
            print("DuplicateBob should not get created multiple times and returns a 422 error message")
            helper.given_new_fixed_user("DuplicateBob")
        error_string = str(excinfo.value)
        assert "request failed (422)" in error_string
        print("There should be a JSON object in the error message that can be parsed")
        json_object = error_string.split(":", 1)[1:][0]
        parsed_json = json.loads(json_object)
        assert parsed_json['errorType'] == "validation"
        assert (
                "'Username in use" in parsed_json['message']
                or "Email in use" in parsed_json['message']
        )
