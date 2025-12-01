import React from 'react';
import { TouchableOpacity, Text, StyleProp, ViewStyle, TextStyle } from 'react-native';

interface ButtonProps {
  title: string;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  accessibilityLabel?: string;
}

const Button: React.FC<ButtonProps> = ({ title, onPress, style, textStyle, accessibilityLabel }) => (
  <TouchableOpacity
    onPress={onPress}
    style={style}
    accessible={true}
    accessibilityRole="button"
    accessibilityLabel={accessibilityLabel || title}
  >
    <Text style={textStyle} accessibilityRole="text" accessibilityLabel={accessibilityLabel || title}>
      {title}
    </Text>
  </TouchableOpacity>
);

export default Button;
