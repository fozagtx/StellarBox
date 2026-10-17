#![no_std]

use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contracterror, contractimpl, contracttype, panic_with_error, Address, Env, Symbol,
    TryFromVal, Vec,
};
use stellar_accounts::{
    policies::Policy,
    smart_account::{ContextRule, Signer},
};

const DAY_IN_LEDGERS: u32 = 17_280;
const MAX_TTL: u32 = 30 * DAY_IN_LEDGERS;
const TTL_THRESHOLD: u32 = MAX_TTL - DAY_IN_LEDGERS;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum TxMaxError {
    InvalidMaxAmount = 3300,
    TxMaxExceeded = 3301,
    FunctionNotAllowed = 3302,
    NotAllowed = 3303,
    NegativeAmount = 3304,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct TxMaxParams {
    pub max_amount: i128,
}

#[contracttype]
pub enum StorageKey {
    AccountContext(Address, u32),
}

#[contract]
pub struct TxMaxPolicy;

#[contractimpl]
impl Policy for TxMaxPolicy {
    type AccountParams = TxMaxParams;

    fn enforce(
        e: &Env,
        context: Context,
        authenticated_signers: Vec<Signer>,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        smart_account.require_auth();

        if authenticated_signers.is_empty() {
            panic_with_error!(e, TxMaxError::NotAllowed);
        }

        let amount = match context {
            Context::Contract(ContractContext { fn_name, args, .. })
                if fn_name == Symbol::new(e, "transfer") =>
            {
                let Some(value) = args.get(2) else {
                    panic_with_error!(e, TxMaxError::FunctionNotAllowed);
                };
                let Ok(amount) = i128::try_from_val(e, &value) else {
                    panic_with_error!(e, TxMaxError::FunctionNotAllowed);
                };
                amount
            }
            _ => panic_with_error!(e, TxMaxError::FunctionNotAllowed),
        };

        if amount < 0 {
            panic_with_error!(e, TxMaxError::NegativeAmount);
        }

        let key = StorageKey::AccountContext(smart_account, context_rule.id);
        let Some(max_amount) = e.storage().persistent().get::<_, i128>(&key) else {
            panic_with_error!(e, TxMaxError::InvalidMaxAmount);
        };
        e.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, MAX_TTL);

        if amount > max_amount {
            panic_with_error!(e, TxMaxError::TxMaxExceeded);
        }
    }

    fn install(
        e: &Env,
        install_params: Self::AccountParams,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        smart_account.require_auth();
        if install_params.max_amount < 0 {
            panic_with_error!(e, TxMaxError::InvalidMaxAmount);
        }

        let key = StorageKey::AccountContext(smart_account, context_rule.id);
        e.storage()
            .persistent()
            .set(&key, &install_params.max_amount);
        e.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, MAX_TTL);
    }

    fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address) {
        smart_account.require_auth();
        let key = StorageKey::AccountContext(smart_account, context_rule.id);
        e.storage().persistent().remove(&key);
    }
}

#[contractimpl]
impl TxMaxPolicy {
    pub fn get_max(e: Env, context_rule_id: u32, smart_account: Address) -> i128 {
        let key = StorageKey::AccountContext(smart_account, context_rule_id);
        let Some(max_amount) = e.storage().persistent().get::<_, i128>(&key) else {
            return 0;
        };
        e.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, MAX_TTL);
        max_amount
    }

    pub fn set_max(e: Env, max_amount: i128, context_rule_id: u32, smart_account: Address) {
        smart_account.require_auth();
        if max_amount < 0 {
            panic_with_error!(&e, TxMaxError::InvalidMaxAmount);
        }
        let key = StorageKey::AccountContext(smart_account, context_rule_id);
        e.storage().persistent().set(&key, &max_amount);
        e.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, MAX_TTL);
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Address, IntoVal, String};

    fn setup() -> (Env, Address, Address, Address, ContextRule) {
        let e = Env::default();
        e.mock_all_auths();
        let policy = e.register(TxMaxPolicy, ());
        let smart_account = Address::generate(&e);
        let token = Address::generate(&e);
        let context_rule = ContextRule {
            id: 7,
            context_type: stellar_accounts::smart_account::ContextRuleType::CallContract(
                token.clone(),
            ),
            name: String::from_str(&e, "agent grant"),
            signers: Vec::from_array(&e, [Signer::Delegated(smart_account.clone())]),
            signer_ids: Vec::from_array(&e, [0]),
            policies: Vec::new(&e),
            policy_ids: Vec::new(&e),
            valid_until: None,
        };
        (e, policy, smart_account, token, context_rule)
    }

    fn transfer_context(e: &Env, token: &Address, fn_name: &str, amount: i128) -> Context {
        let args = Vec::from_array(
            e,
            [
                Address::generate(e).into_val(e),
                Address::generate(e).into_val(e),
                amount.into_val(e),
            ],
        );
        Context::Contract(ContractContext {
            contract: token.clone(),
            fn_name: Symbol::new(e, fn_name),
            args,
        })
    }

    fn install(e: &Env, policy: &Address, smart_account: &Address, rule: &ContextRule) {
        TxMaxPolicyClient::new(e, policy).install(
            &TxMaxParams {
                max_amount: 1_000_000,
            },
            rule,
            smart_account,
        );
    }

    #[test]
    fn under_cap_transfer_succeeds() {
        let (e, policy, smart_account, token, rule) = setup();
        install(&e, &policy, &smart_account, &rule);
        TxMaxPolicyClient::new(&e, &policy).enforce(
            &transfer_context(&e, &token, "transfer", 500_000),
            &Vec::from_array(&e, [Signer::Delegated(smart_account.clone())]),
            &rule,
            &smart_account,
        );
        assert_eq!(
            TxMaxPolicyClient::new(&e, &policy).get_max(&rule.id, &smart_account),
            1_000_000
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3301)")]
    fn over_cap_transfer_panics() {
        let (e, policy, smart_account, token, rule) = setup();
        install(&e, &policy, &smart_account, &rule);
        TxMaxPolicyClient::new(&e, &policy).enforce(
            &transfer_context(&e, &token, "transfer", 1_000_001),
            &Vec::from_array(&e, [Signer::Delegated(smart_account.clone())]),
            &rule,
            &smart_account,
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3302)")]
    fn approve_panics_as_function_not_allowed() {
        let (e, policy, smart_account, token, rule) = setup();
        install(&e, &policy, &smart_account, &rule);
        TxMaxPolicyClient::new(&e, &policy).enforce(
            &transfer_context(&e, &token, "approve", 100),
            &Vec::from_array(&e, [Signer::Delegated(smart_account.clone())]),
            &rule,
            &smart_account,
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3303)")]
    fn empty_signers_panics() {
        let (e, policy, smart_account, token, rule) = setup();
        install(&e, &policy, &smart_account, &rule);
        TxMaxPolicyClient::new(&e, &policy).enforce(
            &transfer_context(&e, &token, "transfer", 100),
            &Vec::new(&e),
            &rule,
            &smart_account,
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3304)")]
    fn negative_amount_panics() {
        let (e, policy, smart_account, token, rule) = setup();
        install(&e, &policy, &smart_account, &rule);
        TxMaxPolicyClient::new(&e, &policy).enforce(
            &transfer_context(&e, &token, "transfer", -1),
            &Vec::from_array(&e, [Signer::Delegated(smart_account.clone())]),
            &rule,
            &smart_account,
        );
    }

    #[test]
    fn uninstall_clears_maximum() {
        let (e, policy, smart_account, _token, rule) = setup();
        install(&e, &policy, &smart_account, &rule);
        TxMaxPolicyClient::new(&e, &policy).uninstall(&rule, &smart_account);
        assert_eq!(
            TxMaxPolicyClient::new(&e, &policy).get_max(&rule.id, &smart_account),
            0
        );
    }
}
