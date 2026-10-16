#![cfg(windows)]
use host_sandbox::self_test;

#[test]
fn the_self_test_runs_on_this_machine() {
    let result = self_test();

    for (name, ok) in &result.checks {
        println!("{} {name}", if *ok { "PASS" } else { "FAIL" });
    }

    println!("confining={} detail={}", result.confining, result.detail);
    assert!(result.confining, "{result:?}");
}
