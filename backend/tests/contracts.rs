#[path = "../src/domain/types.rs"]
#[allow(dead_code)]
mod types;
use rust_decimal_macros::dec;
use types::{Quantity, Rate, UnitPrice, YenAmount};

#[test]
fn exact_numeric_json_roundtrip() {
    assert_eq!(serde_json::to_string(&YenAmount(999_999_999_999_999)).unwrap(), "999999999999999");
    assert_eq!(serde_json::to_string(&Quantity(dec!(12.345))).unwrap(), "\"12.345\"");
    assert_eq!(serde_json::from_str::<Quantity>("\"12.345\"").unwrap(), Quantity(dec!(12.345)));
    assert_eq!(serde_json::from_str::<UnitPrice>("\"0.125\"").unwrap(), UnitPrice(dec!(0.125)));
    assert_eq!(serde_json::from_str::<Rate>("\"1000.00\"").unwrap(), Rate(dec!(1000.00)));
    assert!(serde_json::from_str::<YenAmount>("1.5").is_err());
}
